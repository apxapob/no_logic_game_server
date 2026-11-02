use crate::support::*;
use anyhow::Result;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn guest_dto_chat_json_target_and_raw_binary() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut a = Client::auth(&s.url, json!({"name":"Owner"})).await?;
    let mut b = Client::connect(&s.url).await?;
    assert_eq!(uuid::Uuid::parse_str(a.id())?.get_version_num(), 4);
    assert!(a.account["password"].as_str().unwrap().len() >= 16);
    let r = a.room(json!({})).await?;
    assert_eq!(r["ownerId"], a.id());
    assert_eq!(r["players"], json!([a.id()]));
    assert_eq!(r["hasPassword"], false);
    b.enter(&r).await?;
    a.send("sendChatMsg", json!("hello"))?;
    assert_eq!(
        b.wait("chatMsg").await?,
        json!({"text":"hello","from":a.id()})
    );
    for value in [
        Value::Null,
        json!(true),
        json!(42),
        json!("text"),
        json!([1, 2]),
        json!({"x":1}),
    ] {
        a.send("sendToRoom", value.clone())?;
        assert_eq!(
            b.wait("messageFromPlayer").await?,
            json!({"from":a.id(),"msg":value})
        );
    }
    a.send("sendTo", json!({"to":[b.id()],"msg":42}))?;
    assert_eq!(b.wait("messageFromPlayer").await?["msg"], 42);
    a.bytes(vec![0, 1, 255, 128])?;
    assert_eq!(b.binary().await?, [0, 1, 255, 128]);
    a.none("binary").await?;
    assert_eq!(
        s.sync().await?["stats"],
        json!({"accounts":2,"online":2,"rooms":1,"pendingConnections":0})
    );
    Ok(())
}
#[tokio::test]
async fn credential_failures_do_not_allocate() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let a = Client::connect(&s.url).await?;
    for credentials in [
        json!({"playerId":a.id(),"password":"incorrect"}),
        json!({"playerId":uuid::Uuid::new_v4().to_string(),"password":"chosen"}),
        json!({"playerId":a.id()}),
        json!({"password":"only"}),
    ] {
        let mut c = Client::raw(&s.url, None).await?;
        c.send("authenticate", credentials)?;
        c.wait("wrongPassword").await?;
        c.closed().await?;
        c.none("accountCreated").await?;
        assert_eq!(s.sync().await?["stats"]["accounts"], 1);
    }
    Ok(())
}
#[tokio::test]
async fn origins_paths_and_native_policy() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    for (suffix, origin) in [
        ("?password=secret", None),
        ("", Some("https://attacker.example")),
        ("", Some("null")),
    ] {
        assert!(
            Client::raw(&(s.url.clone() + suffix), origin)
                .await
                .is_err()
        );
    }
    assert_eq!(s.sync().await?["stats"]["accounts"], 0);
    let mut c = Client::raw(&s.url, Some("http://localhost:8081")).await?;
    c.send("authenticate", json!({}))?;
    c.wait("onConnected").await?;
    let _native = Client::connect(&s.url).await?;
    let restricted =
        Relay::start(json!({"allowedOrigins":["https://game.example"],"allowNoOrigin":false}))
            .await?;
    assert!(Client::raw(&restricted.url, None).await.is_err());
    let mut allowed = Client::raw(&restricted.url, Some("https://game.example")).await?;
    allowed.send("authenticate", json!({}))?;
    allowed.wait("onConnected").await?;
    Ok(())
}
#[tokio::test]
async fn authentication_deadline_and_reauthentication() -> Result<()> {
    let mut s = Relay::start(json!({"authTimeoutMs":150})).await?;
    let mut pending = Client::raw(&s.url, None).await?;
    pending.closed().await?;
    assert_eq!(s.sync().await?["stats"]["accounts"], 0);
    let mut c = Client::connect(&s.url).await?;
    c.error("authenticate", json!({}), "invalid_message")
        .await?;
    assert_eq!(s.sync().await?["stats"]["accounts"], 1);
    Ok(())
}
#[tokio::test]
async fn duplicate_socket_fences_old_close() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut old = Client::connect(&s.url).await?;
    let mut peer = Client::connect(&s.url).await?;
    let room = old.room(json!({})).await?;
    peer.enter(&room).await?;
    let before = old.barrier().await?;
    let entry = before
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["playerId"] == old.id())
        .unwrap()["roomEntryTimestamp"]
        .clone();
    old.wait("playerEnter").await?;
    let mut replacement = Client::auth(&s.url, old.account.clone()).await?;
    old.closed().await?;
    let restored = replacement.wait("onRoomEnter").await?;
    assert_eq!(restored["roomId"], room["roomId"]);
    let players = replacement.barrier().await?;
    assert_eq!(
        players
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["playerId"] == old.id())
            .unwrap()["roomEntryTimestamp"],
        entry
    );
    peer.none("playerEnter").await?;
    peer.none("playerLeft").await?;

    assert_eq!(s.sync().await?["stats"]["online"], 2);
    replacement.send("sendToRoom", json!({"current":true}))?;
    assert_eq!(
        peer.wait("messageFromPlayer").await?["msg"]["current"],
        true
    );
    replacement.none("accountCreated").await?;
    Ok(())
}
#[tokio::test]
async fn ghost_rooms_and_membership_errors() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let first = a.room(json!({})).await?;
    let second = b.room(json!({})).await?;
    a.error(
        "createRoom",
        json!({"name":"ghost","maxPlayers":2}),
        "in_other_room",
    )
    .await?;
    a.error(
        "enterRoom",
        json!({"roomId":second["roomId"]}),
        "in_other_room",
    )
    .await?;
    a.error(
        "enterRoom",
        json!({"roomId":first["roomId"]}),
        "already_in_room",
    )
    .await?;
    assert_eq!(s.sync().await?["stats"]["rooms"], 2);
    a.send("getRooms", Value::Null)?;
    assert_eq!(a.wait("onGetRooms").await?.as_array().unwrap().len(), 2);
    Ok(())
}
#[tokio::test]
async fn room_secrets_capacity_and_permissions() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let mut c = Client::connect(&s.url).await?;
    let room = a.room(json!({"password":"secret","maxPlayers":2})).await?;
    assert_eq!(room["hasPassword"], true);
    assert!(room.get("password").is_none());
    b.error(
        "enterRoom",
        json!({"roomId":room["roomId"]}),
        "wrong_password",
    )
    .await?;
    b.send(
        "enterRoom",
        json!({"roomId":room["roomId"],"password":"secret"}),
    )?;
    b.wait("onRoomEnter").await?;
    c.error(
        "enterRoom",
        json!({"roomId":room["roomId"],"password":"secret"}),
        "full_room",
    )
    .await?;
    for (method, data) in [
        ("startGame", json!({})),
        ("setRoomMeta", json!({})),
        ("shareGameState", json!({"gamestate":{}})),
    ] {
        b.error(method, data, "not_room_owner").await?;
    }
    a.send("setRoomMeta", json!({"level":2}))?;
    assert_eq!(b.wait("onSetRoomMeta").await?, json!({"level":2}));
    a.send("startGame", json!({"round":1}))?;
    b.wait("gameStarted").await?;
    a.error("startGame", json!({}), "already_started").await?;
    Ok(())
}
#[tokio::test]
async fn public_players_sort_and_subset_without_secrets() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut lobby = Client::connect(&s.url).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let room = a.room(json!({})).await?;
    b.enter(&room).await?;
    assert!(a.wait("playerEnter").await?["roomEntryTimestamp"].is_number());
    let players = lobby.barrier().await?;
    let mut sorted = players.as_array().unwrap().clone();
    sorted.sort_by_key(|p| {
        (
            p["roomEntryTimestamp"].as_u64().unwrap_or(u64::MAX),
            p["playerId"].as_str().unwrap().to_string(),
        )
    });
    assert_eq!(players, json!(sorted));
    assert_eq!(
        players.as_array().unwrap().last().unwrap()["playerId"],
        lobby.id()
    );
    for p in players.as_array().unwrap() {
        assert!(p.get("password").is_none());
    }
    lobby.send("getPlayers", json!([b.id()]))?;
    let subset = lobby.wait("onGetPlayers").await?;
    assert_eq!(subset.as_array().unwrap().len(), 1);
    assert_eq!(subset[0]["playerId"], b.id());
    Ok(())
}
#[tokio::test]
async fn malformed_envelopes_fields_and_prototypes_survive() -> Result<()> {
    let s = Relay::start(json!({})).await?;
    let mut c = Client::connect(&s.url).await?;
    let mut frames = vec![
        "{".into(),
        "null".into(),
        "[]".into(),
        "42".into(),
        "{}".into(),
    ];
    for method in [
        "toString",
        "constructor",
        "__proto__",
        "hasOwnProperty",
        "missing-method",
    ] {
        frames.push(json!({"method":method}).to_string());
    }
    for (method, data) in [
        ("changeName", json!(42)),
        ("changeName", json!("")),
        ("changeName", json!("x".repeat(65))),
        ("createRoom", Value::Null),
        ("createRoom", json!({"name":"X","maxPlayers":1.5})),
        ("createRoom", json!({"name":"X","maxPlayers":0})),
        (
            "createRoom",
            json!({"name":"X","maxPlayers":2,"password":"x".repeat(129)}),
        ),
        ("enterRoom", json!({"roomId":"bad"})),
        ("sendChatMsg", json!("x".repeat(2049))),
        ("sendTo", json!({"to":[c.id(),c.id()],"msg":{}})),
        ("getPlayers", json!("bad")),
        ("Pong", json!("bad")),
    ] {
        frames.push(json!({"method":method,"data":data}).to_string());
    }
    for frame in frames {
        c.frame(Message::Text(frame.into()))?;
        assert_eq!(c.wait("error").await?["code"], "invalid_message");
        assert!(c.barrier().await?.is_array());
    }
    Ok(())
}
#[tokio::test]
async fn offline_ttl_subsets_and_expired_credentials() -> Result<()> {
    let mut s = Relay::start(json!({"accountTtlMs":500})).await?;
    let mut observer = Client::connect(&s.url).await?;
    let offline = Client::connect(&s.url).await?;
    let account = offline.account.clone();
    drop(offline);
    sleep(30).await;
    assert_eq!(observer.barrier().await?.as_array().unwrap().len(), 1);
    observer.send("getPlayers", json!([account["playerId"]]))?;
    let retained = observer.wait("onGetPlayers").await?;
    assert_eq!(retained[0]["playerId"], account["playerId"]);
    assert!(retained[0].get("password").is_none());
    sleep(550).await;
    assert_eq!(s.sync().await?["stats"]["accounts"], 1);
    observer.send("getPlayers", json!([account["playerId"]]))?;
    assert_eq!(observer.wait("onGetPlayers").await?, json!([]));
    let mut expired = Client::raw(&s.url, None).await?;
    expired.send("authenticate", account)?;
    expired.wait("wrongPassword").await?;
    expired.closed().await?;
    Ok(())
}
