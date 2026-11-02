use crate::support::*;
use anyhow::Result;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

async fn rooms(c: &mut Client) -> Result<Value> {
    c.send("getRooms", Value::Null)?;
    c.wait("onGetRooms").await
}
async fn enter_secret(c: &mut Client, r: &Value, secret: &str) -> Result<Value> {
    c.send("enterRoom", json!({"roomId":r["roomId"],"password":secret}))?;
    c.wait("onRoomEnter").await
}
#[tokio::test]
async fn settings_bounds_and_valid_updates() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut c = Client::connect(&s.url).await?;
    c.room(json!({})).await?;
    for data in [
        json!({}),
        Value::Null,
        json!({"maxPlayers":0}),
        json!({"maxPlayers":17}),
        json!({"maxPlayers":2.5}),
        json!({"maxPlayers":"4"}),
        json!({"password":123}),
        json!({"password":"x".repeat(129)}),
        json!({"name":""}),
        json!({"name":"   "}),
        json!({"name":null}),
        json!({"name":123}),
        json!({"name":"x".repeat(65)}),
    ] {
        c.error("updateRoom", data, "invalid_message").await?;
    }
    for data in [
        json!({"maxPlayers":2}),
        json!({"password":null}),
        json!({"password":""}),
        json!({"password":"secret"}),
        json!({"name":"Renamed"}),
        json!({"name":"x".repeat(64)}),
    ] {
        c.send("updateRoom", data)?;
        c.wait("roomUpdated").await?;
    }
    Ok(())
}
#[tokio::test]
async fn settings_broadcast_capacity_password_rename_and_close() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let mut lobby = Client::connect(&s.url).await?;
    a.error("updateRoom", json!({"maxPlayers":2}), "no_room")
        .await?;
    let r = a.room(json!({})).await?;
    b.enter(&r).await?;
    a.send(
        "updateRoom",
        json!({"maxPlayers":2,"password":"secret","name":"Renamed"}),
    )?;
    let updated = a.wait("roomUpdated").await?;
    assert_eq!(updated["roomId"], r["roomId"]);
    assert_eq!(updated["maxPlayers"], 2);
    assert_eq!(updated["name"], "Renamed");
    assert_eq!(updated["players"], json!([a.id(), b.id()]));
    assert!(updated.get("password").is_none());
    assert_eq!(b.wait("roomUpdated").await?, updated);
    assert_eq!(lobby.wait("roomUpdated").await?, updated);
    assert_eq!(rooms(&mut lobby).await?, json!([updated]));
    lobby
        .error("enterRoom", json!({"roomId":r["roomId"]}), "wrong_password")
        .await?;
    lobby
        .error(
            "enterRoom",
            json!({"roomId":r["roomId"],"password":"secret"}),
            "full_room",
        )
        .await?;
    b.error("updateRoom", json!({"name":"bad"}), "not_room_owner")
        .await?;
    a.error(
        "updateRoom",
        json!({"maxPlayers":1,"password":null}),
        "room_too_small",
    )
    .await?;
    assert_eq!(rooms(&mut a).await?[0]["hasPassword"], true);
    a.send("updateRoom", json!({"maxPlayers":3,"joinClosed":true}))?;
    let closed = a.wait("roomUpdated").await?;
    assert_eq!(closed["joinClosed"], true);
    assert_eq!(closed["hasPassword"], true);
    lobby
        .error(
            "enterRoom",
            json!({"roomId":r["roomId"],"password":"secret"}),
            "room_closed",
        )
        .await?;
    b.send("leaveRoom", Value::Null)?;
    a.wait("playerLeft").await?;
    lobby
        .error(
            "enterRoom",
            json!({"roomId":r["roomId"],"password":"secret"}),
            "room_closed",
        )
        .await?;
    a.send("updateRoom", json!({"joinClosed":false}))?;
    a.wait("roomUpdated").await?;
    enter_secret(&mut lobby, &r, "secret").await?;
    assert_eq!(s.sync().await?["stats"]["rooms"], 1);
    a.send("sendToRoom", json!("healthy"))?;
    assert_eq!(lobby.wait("messageFromPlayer").await?["msg"], "healthy");
    a.send("startGame", json!({}))?;
    a.wait("gameStarted").await?;
    a.error(
        "updateRoom",
        json!({"name":"late","password":null}),
        "already_started",
    )
    .await?;
    Ok(())
}
#[tokio::test]
async fn password_replacement_and_new_owner_editing() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let mut c = Client::connect(&s.url).await?;
    let r = a.room(json!({"password":"old"})).await?;
    enter_secret(&mut b, &r, "old").await?;
    a.send("updateRoom", json!({"password":"new"}))?;
    a.wait("roomUpdated").await?;
    b.wait("roomUpdated").await?;
    c.error(
        "enterRoom",
        json!({"roomId":r["roomId"],"password":"old"}),
        "wrong_password",
    )
    .await?;
    a.send("leaveRoom", Value::Null)?;
    b.wait("newRoomOwner").await?;
    b.send("updateRoom", json!({"password":null}))?;
    let updated = b.wait("roomUpdated").await?;
    assert_eq!(updated["ownerId"], b.id());
    assert_eq!(updated["hasPassword"], false);
    c.enter(&r).await?;
    b.send("updateRoom", json!({"password":""}))?;
    assert_eq!(b.wait("roomUpdated").await?["hasPassword"], false);
    Ok(())
}
#[tokio::test]
async fn settings_growth_and_rename_are_atomic_at_payload_limit() -> Result<()> {
    let s = Relay::start(json!({"maxRoomPlayers":100,"maxPayloadBytes":1024})).await?;
    let mut a = Client::connect(&s.url).await?;
    let r = a.room(json!({"name":"A","maxPlayers":2})).await?;
    a.error(
        "updateRoom",
        json!({"name":"Renamed","maxPlayers":100,"password":"secret"}),
        "payload_too_large",
    )
    .await?;
    let same = rooms(&mut a).await?;
    assert_eq!(same[0]["name"], "A");
    assert_eq!(same[0]["maxPlayers"], 2);
    assert_eq!(same[0]["hasPassword"], false);
    let mut reserved = r.clone();
    reserved["rtt"] = json!(9007199254740991u64);
    reserved["players"] = json!([a.id(), a.id()]);
    reserved["metaData"] = json!("");
    let overhead = json!({"method":"onGetRooms","data":[reserved],"nextCursor":r["roomId"]})
        .to_string()
        .len();
    a.send("setRoomMeta", json!("x".repeat(1024 - overhead)))?;
    a.wait("onSetRoomMeta").await?;
    a.error(
        "updateRoom",
        json!({"name":"x".repeat(64),"password":"new"}),
        "payload_too_large",
    )
    .await?;
    let same = rooms(&mut a).await?;
    assert_eq!(same[0]["name"], "A");
    assert_eq!(same[0]["hasPassword"], false);
    Ok(())
}
#[tokio::test]
async fn legacy_disconnect_reserves_but_leave_revokes_and_empty_disposes() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let mut c = Client::connect(&s.url).await?;
    let r = a.room(json!({})).await?;
    b.enter(&r).await?;
    a.send("startGame", json!({}))?;
    b.wait("gameStarted").await?;
    a.disconnect();
    assert_eq!(b.wait("playerDisconnected").await?, a.id());
    assert_eq!(b.wait("newRoomOwner").await?, b.id());
    assert_eq!(rooms(&mut b).await?[0]["players"], json!([b.id()]));
    let mut back = Client::auth(&s.url, a.account.clone()).await?;
    back.enter(&r).await?;
    b.wait("playerEnter").await?;
    c.error(
        "enterRoom",
        json!({"roomId":r["roomId"]}),
        "game_started_without_you",
    )
    .await?;
    back.send("leaveRoom", Value::Null)?;
    b.wait("playerLeft").await?;
    back.error(
        "enterRoom",
        json!({"roomId":r["roomId"]}),
        "game_started_without_you",
    )
    .await?;
    b.disconnect();
    sleep(30).await;
    assert_eq!(s.sync().await?["stats"]["rooms"], 0);
    back.error("enterRoom", json!({"roomId":r["roomId"]}), "no_room")
        .await?;
    Ok(())
}
#[tokio::test]
async fn switching_rooms_isolates_all_transports_and_state_requests() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let mut c = Client::connect(&s.url).await?;
    let first = a.room(json!({})).await?;
    b.enter(&first).await?;
    let second = c.room(json!({})).await?;
    a.send("leaveRoom", Value::Null)?;
    b.wait("playerLeft").await?;
    assert_eq!(b.wait("newRoomOwner").await?, b.id());
    a.enter(&second).await?;
    b.send("sendToRoom", json!("stale"))?;
    b.send("sendTo", json!({"to":[a.id()],"msg":"stale"}))?;
    b.send("shareGameState", json!({"to":[a.id()],"gamestate":"stale"}))?;
    b.bytes(b"stale".to_vec())?;
    b.barrier().await?;
    for method in ["messageFromPlayer", "newGameState", "binary"] {
        a.none(method).await?;
    }
    a.send("sendToRoom", json!("fresh"))?;
    assert_eq!(c.wait("messageFromPlayer").await?["msg"], "fresh");
    b.none("messageFromPlayer").await?;
    a.send("requestGameState", Value::Null)?;
    assert_eq!(c.wait("gameStateRequested").await?["playerId"], a.id());
    b.none("gameStateRequested").await?;
    Ok(())
}
#[tokio::test]
async fn reservation_cannot_override_current_membership() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let r = a.room(json!({})).await?;
    b.enter(&r).await?;
    a.send("startGame", json!({}))?;
    b.wait("gameStarted").await?;
    b.disconnect();
    a.wait("playerDisconnected").await?;
    let mut back = Client::auth(&s.url, b.account.clone()).await?;
    let other = back.room(json!({})).await?;
    back.error("enterRoom", json!({"roomId":r["roomId"]}), "in_other_room")
        .await?;
    assert_eq!(other["players"], json!([back.id()]));
    a.send("sendTo", json!({"to":[back.id()],"msg":"reserved"}))?;
    a.bytes(b"reserved".to_vec())?;
    back.none("messageFromPlayer").await?;
    back.none("binary").await?;
    Ok(())
}
#[tokio::test]
async fn fixed_roster_visibility_rejoin_and_leave() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut host = Client::connect(&s.url).await?;
    let mut peer = Client::connect(&s.url).await?;
    let mut outsider = Client::connect(&s.url).await?;
    let r = host.room(json!({"password":"secret"})).await?;
    outsider.wait("roomCreated").await?;
    enter_secret(&mut peer, &r, "secret").await?;
    host.send("startGame", json!({"fixedRoster":true}))?;
    peer.wait("gameStarted").await?;
    outsider.wait("roomBlock").await?;
    assert_eq!(rooms(&mut outsider).await?, json!([]));
    peer.disconnect();
    host.wait("playerDisconnected").await?;
    outsider.none("roomCreated").await?;
    outsider
        .error(
            "enterRoom",
            json!({"roomId":r["roomId"],"password":"secret"}),
            "game_started_without_you",
        )
        .await?;
    let mut back = Client::auth(&s.url, peer.account.clone()).await?;
    assert_eq!(rooms(&mut back).await?[0]["roomId"], r["roomId"]);
    assert_eq!(back.enter(&r).await?["gameStarted"], true);
    back.send("leaveRoom", Value::Null)?;
    host.wait("playerLeft").await?;
    assert_eq!(back.wait("roomCreated").await?["roomId"], r["roomId"]);
    outsider.none("roomCreated").await?;
    back.enter(&r).await?;
    Ok(())
}
#[tokio::test]
async fn fixed_roster_host_loss_ends_room() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut host = Client::connect(&s.url).await?;
    let mut peer = Client::connect(&s.url).await?;
    let r = host.room(json!({})).await?;
    peer.enter(&r).await?;
    host.send("startGame", json!({"fixedRoster":true}))?;
    peer.wait("gameStarted").await?;
    host.disconnect();
    peer.wait("playerDisconnected").await?;
    peer.barrier().await?;
    peer.none("newRoomOwner").await?;
    assert_eq!(s.sync().await?["stats"]["rooms"], 0);
    peer.room(json!({})).await?;
    Ok(())
}
#[tokio::test]
async fn fixed_roster_socket_replacement_and_reserved_ttl() -> Result<()> {
    let s = Relay::start(json!({"accountTtlMs":50})).await?;
    let mut host = Client::connect(&s.url).await?;
    let mut peer = Client::connect(&s.url).await?;
    let r = host.room(json!({})).await?;
    peer.enter(&r).await?;
    host.wait("playerEnter").await?;
    host.send("startGame", json!({"fixedRoster":true}))?;
    peer.wait("gameStarted").await?;
    let mut back = Client::auth(&s.url, peer.account.clone()).await?;
    assert_eq!(host.wait("playerDisconnected").await?, peer.id());
    peer.closed().await?;
    assert_eq!(
        back.enter(&r).await?["players"].as_array().unwrap().len(),
        2
    );
    host.wait("playerEnter").await?;
    back.disconnect();
    host.wait("playerDisconnected").await?;
    sleep(120).await;
    let mut again = Client::auth(&s.url, peer.account.clone()).await?;
    again.enter(&r).await?;
    Ok(())
}
#[tokio::test]
async fn migration_generations_and_membership_order() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut host = Client::connect(&s.url).await?;
    let mut peer = Client::connect(&s.url).await?;
    let mut third = Client::connect(&s.url).await?;
    let mut outsider = Client::connect(&s.url).await?;
    let r = host.room(json!({})).await?;
    peer.enter(&r).await?;
    third.enter(&r).await?;
    host.send(
        "startGame",
        json!({"fixedRoster":true,"hostMigration":true}),
    )?;
    peer.wait("gameStarted").await?;
    host.disconnect();
    assert_eq!(
        peer.wait("newRoomOwner").await?,
        json!({"playerId":peer.id(),"generation":1})
    );
    outsider
        .error(
            "enterRoom",
            json!({"roomId":r["roomId"]}),
            "game_started_without_you",
        )
        .await?;
    let mut back = Client::auth(&s.url, host.account.clone()).await?;
    let restored = back.enter(&r).await?;
    assert_eq!(restored["ownerId"], peer.id());
    assert_eq!(restored["hostGeneration"], 1);
    peer.send("leaveRoom", Value::Null)?;
    assert_eq!(
        back.wait("newRoomOwner").await?,
        json!({"playerId":third.id(),"generation":2})
    );
    back.send("leaveRoom", Value::Null)?;
    third.send("leaveRoom", Value::Null)?;
    third.barrier().await?;
    assert_eq!(s.sync().await?["stats"]["rooms"], 0);
    Ok(())
}
#[tokio::test]
async fn binary_routing_authenticates_and_rejects_cross_room_targets() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut host = Client::connect(&s.url).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let mut outsider = Client::connect(&s.url).await?;
    let r = host.room(json!({"binaryRelay":true})).await?;
    assert_eq!(a.enter(&r).await?["binaryRelay"], true);
    b.enter(&r).await?;
    outsider.room(json!({"binaryRelay":true})).await?;
    host.bytes(packet(Some(a.id()), &[255, 0, 128, 42]))?;
    let delivered = a.binary().await?;
    assert_eq!(
        &delivered[1..17],
        uuid::Uuid::parse_str(host.id())?.as_bytes()
    );
    assert_eq!(&delivered[17..], &[255, 0, 128, 42]);
    host.bytes(packet(Some(outsider.id()), b"bad"))?;
    host.bytes(packet(None, b"broadcast"))?;
    for c in [&mut a, &mut b] {
        assert_eq!(&c.binary().await?[17..], b"broadcast");
        c.none("binary").await?;
    }
    host.none("binary").await?;
    outsider.none("binary").await?;
    Ok(())
}
#[tokio::test]
async fn binary_validation_legacy_frames_and_numeric_json() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    a.error(
        "createRoom",
        json!({"name":"room","maxPlayers":4,"binaryRelay":"yes"}),
        "invalid_message",
    )
    .await?;
    let r = a.room(json!({"binaryRelay":true})).await?;
    b.enter(&r).await?;
    for bytes in [
        vec![0; 17],
        vec![9; 18],
        packet(Some("00112233-4455-0677-8899-aabbccddeeff"), b"x"),
        packet(Some("00112233-4455-4677-ff99-aabbccddeeff"), b"x"),
    ] {
        a.bytes(bytes)?;
        assert_eq!(a.wait("error").await?["code"], "invalid_message");
    }
    b.none("binary").await?;
    a.send("leaveRoom", Value::Null)?;
    a.frame(Message::Text(
        "{\"method\":\"createRoom\",\"data\":{\"name\":\"C#\",\"maxPlayers\":4.0}}".into(),
    ))?;
    let r = a.wait("onRoomEnter").await?;
    assert_eq!(r["maxPlayers"], 4);
    assert!(r.get("binaryRelay").is_none());
    b.send("leaveRoom", Value::Null)?;
    b.enter(&r).await?;
    for tag in [0xf7, 0xf8] {
        let mut frame = vec![tag];
        for id in [a.id(), b.id()] {
            let mut guid = *uuid::Uuid::parse_str(id)?.as_bytes();
            guid[..4].reverse();
            guid[4..6].reverse();
            guid[6..8].reverse();
            frame.extend(guid);
        }
        frame.extend(1500u16.to_le_bytes());
        frame.extend(vec![42; 1500]);
        a.bytes(frame.clone())?;
        assert_eq!(b.binary().await?, frame);
    }
    Ok(())
}
#[tokio::test]
async fn delayed_transitions_fence_json_raw_and_routed_frames() -> Result<()> {
    for routed in [false, true] {
        let mut s = Relay::start(json!({})).await?;
        let mut a = Client::connect(&s.url).await?;
        let mut b = Client::connect(&s.url).await?;
        let mut c = Client::connect(&s.url).await?;
        let first = b.room(json!({"binaryRelay":routed})).await?;
        let second = c.room(json!({"binaryRelay":routed})).await?;
        a.enter(&first).await?;
        b.wait("playerEnter").await?;
        s.control(json!({"options":{"sendDelayMs":80}})).await?;
        a.send("leaveRoom", Value::Null)?;
        a.send("enterRoom", json!({"roomId":second["roomId"]}))?;
        a.send("sendToRoom", json!("stale"))?;
        a.send("sendTo", json!({"to":[c.id()],"msg":"stale"}))?;
        a.bytes(if routed {
            packet(None, b"stale")
        } else {
            b"stale".to_vec()
        })?;
        a.send("getPlayers", json!([a.id()]))?;
        assert_eq!(a.wait("onRoomEnter").await?["roomId"], second["roomId"]);
        assert!(a.wait("onGetPlayers").await?[0]["roomEntryTimestamp"].is_number());
        assert_eq!(b.wait("playerLeft").await?, a.id());
        assert_eq!(c.wait("playerEnter").await?["playerId"], a.id());
        sleep(100).await;
        for peer in [&mut b, &mut c] {
            peer.none("messageFromPlayer").await?;
            peer.none("binary").await?;
        }
        a.send("sendToRoom", json!("fresh"))?;
        assert_eq!(c.wait("messageFromPlayer").await?["msg"], "fresh");
        a.bytes(if routed {
            packet(Some(c.id()), b"fresh")
        } else {
            b"fresh".to_vec()
        })?;
        let delivered = c.binary().await?;
        assert_eq!(
            if routed {
                &delivered[17..]
            } else {
                &delivered[..]
            },
            b"fresh"
        );
    }
    Ok(())
}
