use crate::support::*;
use anyhow::Result;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
async fn subset(c: &mut Client) -> Result<Value> {
    c.send("getPlayers", json!([c.id()]))?;
    let v = c.wait("onGetPlayers").await?;
    assert_eq!(v[0]["playerId"], c.id());
    Ok(v[0].clone())
}
async fn raw(s: &Relay) -> Result<TcpStream> {
    Ok(TcpStream::connect(s.url.trim_start_matches("ws://").trim_end_matches('/')).await?)
}
#[tokio::test]
async fn accounts_rooms_and_capacity_limits_release() -> Result<()> {
    let mut s = Relay::start(json!({"maxAccounts":2,"maxRooms":1,"maxRoomPlayers":2})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let mut extra = Client::raw(&s.url, None).await?;
    extra
        .error("authenticate", json!({}), "limit_exceeded")
        .await?;
    extra.none("accountCreated").await?;
    assert_eq!(s.sync().await?["stats"]["accounts"], 2);
    a.error(
        "createRoom",
        json!({"name":"too large","maxPlayers":3}),
        "invalid_message",
    )
    .await?;
    a.room(json!({"maxPlayers":2})).await?;
    b.error(
        "createRoom",
        json!({"name":"too many","maxPlayers":2}),
        "limit_exceeded",
    )
    .await?;
    a.send("leaveRoom", Value::Null)?;
    a.barrier().await?;
    assert_eq!(s.sync().await?["stats"]["rooms"], 0);
    b.room(json!({"maxPlayers":2})).await?;
    Ok(())
}
#[tokio::test]
async fn pending_and_raw_transports_obey_global_and_ip_limits() -> Result<()> {
    for options in [
        json!({"maxConnections":1}),
        json!({"maxConnectionsPerIp":1}),
    ] {
        let mut s = Relay::start(options).await?;
        let mut pending = Client::raw(&s.url, None).await?;
        assert!(Client::raw(&s.url, None).await.is_err());
        assert_eq!(s.sync().await?["stats"]["pendingConnections"], 1);
        pending.send("authenticate", json!({}))?;
        pending.wait("onConnected").await?;
        pending.disconnect();
        sleep(30).await;
        let healthy = Client::connect(&s.url).await?;
        healthy.disconnect();
        sleep(30).await;
        let mut held = raw(&s).await?;
        let mut extra = raw(&s).await?;
        assert_eq!(
            tokio::time::timeout(WAIT, extra.read(&mut [0; 32])).await??,
            0
        );
        let mut req = s.url.as_str().into_client_request()?;
        req.headers_mut()
            .insert("X-Forwarded-For", "192.0.2.42".parse()?);
        assert!(tokio_tungstenite::connect_async(req).await.is_err());
        held.shutdown().await?;
        assert_eq!(
            tokio::time::timeout(WAIT, held.read(&mut [0; 32])).await??,
            0
        );
        let _again = Client::connect(&s.url).await?;
    }
    Ok(())
}
#[tokio::test]
async fn attempt_limit_ignores_forwarded_headers() -> Result<()> {
    let mut s = Relay::start(json!({"maxConnectionsPerMinute":2})).await?;
    for _ in 0..2 {
        let c = Client::connect(&s.url).await?;
        c.disconnect();
        sleep(20).await;
    }
    let mut req = s.url.as_str().into_client_request()?;
    req.headers_mut()
        .insert("X-Forwarded-For", "192.0.2.123".parse()?);
    assert!(tokio_tungstenite::connect_async(req).await.is_err());
    assert_eq!(s.sync().await?["stats"]["accounts"], 2);
    Ok(())
}
#[tokio::test]
async fn oversized_frames_and_message_flood_leave_peers_alive() -> Result<()> {
    let mut s = Relay::start(json!({"maxPayloadBytes":512})).await?;
    let mut healthy = Client::connect(&s.url).await?;
    for binary in [false, true] {
        let mut bad = Client::connect(&s.url).await?;
        bad.frame(if binary {
            Message::Binary(vec![0; 513].into())
        } else {
            Message::Text("x".repeat(513).into())
        })?;
        bad.closed().await?;
    }
    assert!(healthy.barrier().await?.is_array());
    assert_eq!(s.sync().await?["stats"]["online"], 1);
    for binary in [false, true] {
        let s = Relay::start(json!({"maxMessagesPerSecond":4})).await?;
        let mut bad = Client::connect(&s.url).await?;
        for i in 0..8 {
            if binary {
                bad.bytes(vec![i])?
            } else {
                bad.send("getRooms", Value::Null)?
            }
        }
        bad.closed().await?;
        let mut healthy = Client::connect(&s.url).await?;
        healthy.barrier().await?;
    }
    Ok(())
}
#[tokio::test]
async fn control_ping_echo_and_shared_quota() -> Result<()> {
    let mut s = Relay::start(json!({"maxMessagesPerSecond":12})).await?;
    let mut healthy = Client::connect(&s.url).await?;
    let mut bad = Client::connect(&s.url).await?;
    bad.frame(Message::Ping(b"normal".to_vec().into()))?;
    assert_eq!(bad.take("pong").await?.into_data(), b"normal"[..]);
    for _ in 0..4 {
        bad.send("getRooms", Value::Null)?;
    }
    for _ in 0..4 {
        bad.frame(Message::Pong(b"unsolicited".to_vec().into()))?;
    }
    for name in ["allowed-1", "allowed-2", "over-limit"] {
        bad.frame(Message::Ping(name.as_bytes().to_vec().into()))?;
    }
    bad.closed().await?;
    for expected in ["allowed-1", "allowed-2"] {
        assert_eq!(bad.take("pong").await?.into_data(), expected.as_bytes());
    }
    bad.none("pong").await?;
    healthy.barrier().await?;
    assert_eq!(s.sync().await?["stats"]["online"], 1);
    Ok(())
}
#[tokio::test]
async fn control_quota_before_auth_and_unsolicited_pong_flood() -> Result<()> {
    for authenticated in [false, true] {
        let mut s = Relay::start(json!({"maxMessagesPerSecond":8,"authTimeoutMs":10000})).await?;
        let mut healthy = Client::connect(&s.url).await?;
        let mut bad = if authenticated {
            Client::connect(&s.url).await?
        } else {
            Client::raw(&s.url, None).await?
        };
        for i in 0..16 {
            let b = vec![i; 125].into();
            bad.frame(if authenticated {
                Message::Pong(b)
            } else {
                Message::Ping(b)
            })?;
        }
        bad.closed().await?;
        if !authenticated {
            for _ in 0..8 {
                bad.take("pong").await?;
            }
        }
        bad.none("pong").await?;
        healthy.barrier().await?;
        let stats = s.sync().await?;
        assert_eq!(stats["stats"]["online"], 1);
        assert_eq!(stats["stats"]["pendingConnections"], 0);
        assert_eq!(
            stats["stats"]["accounts"],
            if authenticated { 2 } else { 1 }
        );
    }
    Ok(())
}
#[tokio::test]
async fn heartbeat_only_accepts_outstanding_timestamp_once() -> Result<()> {
    let s = Relay::start(json!({"heartbeatIntervalMs":500,"idleTimeoutMs":2000})).await?;
    let mut c = Client::connect(&s.url).await?;
    let initial = subset(&mut c).await?["rtt"].clone();
    c.send("Pong", json!(9007199254740000u64))?;
    assert_eq!(subset(&mut c).await?["rtt"], initial);
    let timestamp = c.wait("Ping").await?;
    c.send("Pong", timestamp.clone())?;
    let rtt = subset(&mut c).await?["rtt"].clone();
    assert!(rtt.is_number());
    sleep(30).await;
    c.send("Pong", timestamp)?;
    c.send("Pong", json!(-1))?;
    assert_eq!(subset(&mut c).await?["rtt"], rtt);
    Ok(())
}
#[tokio::test]
async fn stalled_close_disposes_rooms_and_does_not_evict_replacement() -> Result<()> {
    for started in [false, true] {
        let mut s = Relay::start(json!({})).await?;
        let mut owner = Client::connect(&s.url).await?;
        let mut observer = Client::connect(&s.url).await?;
        let room = owner.room(json!({})).await?;
        if started {
            owner.send("startGame", json!({}))?;
            owner.wait("gameStarted").await?;
        }
        owner.pause(true);
        sleep(5).await;
        owner.frame(Message::Close(None))?;
        assert_eq!(observer.wait("roomDeleted").await?, room["roomId"]);
        let stats = s.sync().await?;
        assert_eq!(stats["stats"]["rooms"], 0);
        assert_eq!(stats["stats"]["online"], 1);
        owner.pause(false);
        owner.closed().await?;
        observer.none("roomDeleted").await?;
    }
    let mut s = Relay::start(json!({})).await?;
    let mut owner = Client::connect(&s.url).await?;
    let mut peer = Client::connect(&s.url).await?;
    let room = owner.room(json!({})).await?;
    peer.enter(&room).await?;
    owner.send("startGame", json!({}))?;
    peer.wait("gameStarted").await?;
    owner.pause(true);
    sleep(5).await;
    owner.frame(Message::Close(None))?;
    peer.wait("playerDisconnected").await?;
    assert_eq!(peer.wait("newRoomOwner").await?, peer.id());
    let mut back = Client::auth(&s.url, owner.account.clone()).await?;
    assert_eq!(
        back.enter(&room).await?["players"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    owner.pause(false);
    owner.closed().await?;
    back.barrier().await?;
    peer.none("playerDisconnected").await?;
    peer.none("newRoomOwner").await?;
    assert_eq!(s.sync().await?["stats"]["online"], 2);
    back.send("sendToRoom", json!("still connected"))?;
    assert_eq!(
        peer.wait("messageFromPlayer").await?["msg"],
        "still connected"
    );
    Ok(())
}
#[tokio::test]
async fn silent_room_expires_and_wrong_pongs_cannot_extend_deadline() -> Result<()> {
    let mut s = Relay::start(json!({"heartbeatIntervalMs":50,"idleTimeoutMs":400})).await?;
    let mut observer = Client::connect(&s.url).await?;
    observer.heartbeats();
    let mut clients = vec![];
    for _ in 0..3 {
        clients.push(Client::connect(&s.url).await?);
    }
    let room = clients[0].room(json!({})).await?;
    for c in clients.iter_mut().skip(1) {
        c.enter(&room).await?;
    }
    clients[0].send("startGame", json!({}))?;
    clients[0].wait("gameStarted").await?;
    for c in &mut clients {
        c.closed().await?;
    }
    observer.wait("roomDeleted").await?;
    assert_eq!(s.sync().await?["stats"]["online"], 1);
    assert_eq!(s.sync().await?["stats"]["rooms"], 0);
    let mut back = Client::auth(&s.url, clients[0].account.clone()).await?;
    back.error("enterRoom", json!({"roomId":room["roomId"]}), "no_room")
        .await?;
    back.heartbeats();
    let mut bad = Client::connect(&s.url).await?;
    let room = bad.room(json!({})).await?;
    back.enter(&room).await?;
    let timestamp = bad.wait("Ping").await?.as_i64().unwrap();
    for _ in 0..12 {
        let _ = bad.send("getRooms", Value::Null);
        let _ = bad.send("Pong", json!(timestamp - 1));
        let _ = bad.frame(Message::Ping(vec![1].into()));
        sleep(40).await;
    }
    bad.closed().await?;
    back.wait("playerDisconnected").await?;
    assert_eq!(back.wait("newRoomOwner").await?, back.id());
    back.send("getRooms", Value::Null)?;
    assert_eq!(
        back.wait("onGetRooms").await?[0]["players"],
        json!([back.id()])
    );
    Ok(())
}
#[tokio::test]
async fn delayed_shutdown_and_raw_transport_shutdown_are_bounded() -> Result<()> {
    let mut s = Relay::start(json!({"sendDelayMs":80})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let room = a.room(json!({})).await?;
    b.enter(&room).await?;
    a.send("sendToRoom", json!("pending"))?;
    a.bytes(b"pending".to_vec())?;
    s.stop().await?;
    a.closed().await?;
    b.closed().await?;
    b.none("messageFromPlayer").await?;
    b.none("binary").await?;
    s.stop().await?;
    let mut s = Relay::start(json!({"shutdownTimeoutMs":100,"authTimeoutMs":10000})).await?;
    let mut silent = raw(&s).await?;
    let mut partial = raw(&s).await?;
    partial
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: ")
        .await?;
    assert_eq!(s.health().await?["status"], "ok");
    let started = Instant::now();
    s.stop().await?;
    let mut b = [0; 1024];
    assert_eq!(silent.read(&mut b).await?, 0);
    let _ = partial.read(&mut b).await;
    assert!(started.elapsed() < Duration::from_secs(2));
    Ok(())
}
#[tokio::test]
async fn rejected_upgrades_release_admission_and_health_is_independent() -> Result<()> {
    let mut first = Relay::start(json!({"maxConnections":1})).await?;
    let second = Relay::start(json!({})).await?;
    for _ in 0..3 {
        let mut tcp = raw(&first).await?;
        tcp.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: https://attacker.example\r\n\r\n").await?;
        let mut response = vec![];
        tokio::time::timeout(WAIT, tcp.read_to_end(&mut response)).await??;
        assert!(response.starts_with(b"HTTP/1.1 403"));
    }
    assert_eq!(first.sync().await?["stats"]["accounts"], 0);
    let mut c = Client::connect(&first.url).await?;
    c.barrier().await?;
    let port = first
        .url
        .trim_start_matches("ws://127.0.0.1:")
        .trim_end_matches('/')
        .parse::<u16>()?;
    assert!(Relay::start(json!({"port":port})).await.is_err());
    first.stop().await?;
    c.closed().await?;
    assert_eq!(second.health().await?["status"], "ok");
    let response = reqwest::get(second.url.replace("ws:", "http:") + "missing").await?;
    assert_eq!(response.status(), 404);
    Ok(())
}
#[tokio::test]
async fn output_limits_include_envelope_and_do_not_disconnect_peers() -> Result<()> {
    for binary in [false, true] {
        let mut s = Relay::start(json!({"maxBufferedBytes":512,"maxPayloadBytes":4096})).await?;
        let mut a = Client::connect(&s.url).await?;
        let mut b = Client::connect(&s.url).await?;
        let room = a.room(json!({})).await?;
        b.enter(&room).await?;
        if binary {
            a.bytes(vec![1; 1024])?;
            assert_eq!(a.wait("error").await?["code"], "payload_too_large");
        } else {
            a.error("sendToRoom", json!("x".repeat(440)), "payload_too_large")
                .await?;
            a.error(
                "sendTo",
                json!({"to":[b.id()],"msg":"x".repeat(1024)}),
                "payload_too_large",
            )
            .await?;
        }
        subset(&mut a).await?;
        subset(&mut b).await?;
        b.none(if binary {
            "binary"
        } else {
            "messageFromPlayer"
        })
        .await?;
        assert_eq!(s.sync().await?["stats"]["online"], 2);
        a.send("sendToRoom", json!("healthy"))?;
        assert_eq!(b.wait("messageFromPlayer").await?["msg"], "healthy");
    }
    Ok(())
}
#[tokio::test]
async fn canonical_expansion_and_deep_json_reject_before_allocation_or_fanout() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let numbers = vec!["1e20"; 12000].join(",");
    let raw = format!(
        "{{\"method\":\"createRoom\",\"data\":{{\"name\":\"Expansion\",\"maxPlayers\":4,\"gameData\":[{numbers}]}}}}"
    );
    assert!(raw.len() < 65536);
    a.frame(Message::Text(raw.into()))?;
    assert_eq!(a.wait("error").await?["code"], "payload_too_large");
    assert_eq!(s.sync().await?["stats"]["rooms"], 0);
    b.none("roomCreated").await?;
    a.none("onRoomEnter").await?;
    let room = a.room(json!({})).await?;
    b.enter(&room).await?;
    a.frame(Message::Text(
        format!("{{\"method\":\"sendToRoom\",\"data\":[{numbers}]}}").into(),
    ))?;
    assert_eq!(a.wait("error").await?["code"], "payload_too_large");
    b.none("messageFromPlayer").await?;
    let raw = format!(
        "{{\"method\":\"getRooms\",\"extension\":{}0{}}}",
        "[".repeat(10000),
        "]".repeat(10000)
    );
    a.frame(Message::Text(raw.into()))?;
    assert_eq!(a.wait("error").await?["code"], "invalid_message");
    let mut nested = Value::Null;
    for _ in 0..64 {
        nested = json!({"child":nested});
    }
    a.error("sendToRoom", nested, "invalid_message").await?;
    a.barrier().await?;
    b.none("messageFromPlayer").await?;
    a.send("sendToRoom", json!(1))?;
    assert_eq!(b.wait("messageFromPlayer").await?["msg"], 1);
    Ok(())
}
#[tokio::test]
async fn reserved_dto_capacity_and_oversized_player_aggregate() -> Result<()> {
    let mut s = Relay::start(json!({"maxPayloadBytes":4096,"maxBufferedBytes":4096})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    a.error(
        "createRoom",
        json!({"name":"Reserved","maxPlayers":16,"gameData":"x".repeat(3400)}),
        "payload_too_large",
    )
    .await?;
    assert_eq!(s.sync().await?["stats"]["rooms"], 0);
    b.none("roomCreated").await?;
    a.room(json!({"maxPlayers":1,"gameData":"x".repeat(3400)}))
        .await?;
    a.send("leaveRoom", Value::Null)?;
    a.barrier().await?;
    let room = a
        .room(json!({"maxPlayers":16,"gameData":"x".repeat(3000)}))
        .await?;
    b.enter(&room).await?;
    a.error("setRoomMeta", json!("y".repeat(300)), "payload_too_large")
        .await?;
    b.none("onSetRoomMeta").await?;
    let mut s = Relay::start(json!({"maxPayloadBytes":4096,"maxBufferedBytes":512})).await?;
    let mut clients = vec![];
    for _ in 0..4 {
        clients.push(Client::auth(&s.url, json!({"name":"n".repeat(64)})).await?);
    }
    clients[0]
        .error("getPlayers", Value::Null, "response_too_large")
        .await?;
    for c in &mut clients {
        subset(c).await?;
    }
    assert_eq!(s.sync().await?["stats"]["online"], 4);
    Ok(())
}
#[tokio::test]
async fn metadata_is_atomic_and_paginated_cursors_survive_deletion() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut reader = Client::connect(&s.url).await?;
    let mut owners = vec![];
    let mut rooms = vec![];
    for i in 0..3 {
        let mut a = Client::connect(&s.url).await?;
        let room = a.room(json!({"gameData":"x".repeat(50000)})).await?;
        reader.wait("roomCreated").await?;
        a.send("setRoomMeta", json!({"previous":i}))?;
        a.wait("onSetRoomMeta").await?;
        a.error("setRoomMeta", json!("y".repeat(50000)), "payload_too_large")
            .await?;
        owners.push(a);
        rooms.push(room);
    }
    reader.enter(&rooms[0]).await?;
    owners[0]
        .error("setRoomMeta", json!("y".repeat(50000)), "payload_too_large")
        .await?;
    reader.none("onSetRoomMeta").await?;
    let mut cursor = Value::Null;
    let mut seen = vec![];
    let mut pages = 0;
    loop {
        reader.send(
            "getRooms",
            if cursor.is_null() {
                Value::Null
            } else {
                json!({"after":cursor})
            },
        )?;
        let msg = reader.take("onGetRooms").await?;
        assert!(msg.len() <= 65536);
        let response: Value = serde_json::from_str(msg.to_text()?)?;
        assert!(!response["data"].as_array().unwrap().is_empty());
        seen.extend(response["data"].as_array().unwrap().clone());
        pages += 1;
        assert!(pages <= 3);
        cursor = response["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert!(pages > 1);
    let mut ids: Vec<_> = rooms.iter().map(|r| r["roomId"].clone()).collect();
    ids.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    assert_eq!(
        seen.iter().map(|r| r["roomId"].clone()).collect::<Vec<_>>(),
        ids
    );
    for r in &seen {
        let index = rooms
            .iter()
            .position(|v| v["roomId"] == r["roomId"])
            .unwrap();
        assert_eq!(r["metaData"], json!({"previous":index}));
    }
    for after in [json!("not-a-uuid"), json!(42)] {
        reader
            .error("getRooms", json!({"after":after}), "invalid_message")
            .await?;
    }
    for value in [Value::Null, json!({})] {
        reader.send("getRooms", value)?;
        assert_eq!(reader.wait("onGetRooms").await?[0]["roomId"], ids[0]);
    }
    reader.send("leaveRoom", Value::Null)?;
    reader.barrier().await?;
    let index = rooms.iter().position(|r| r["roomId"] == ids[0]).unwrap();
    owners[index].send("leaveRoom", Value::Null)?;
    owners[index].barrier().await?;
    assert_eq!(s.sync().await?["stats"]["rooms"], 2);
    reader.send("getRooms", json!({"after":ids[0]}))?;
    assert_eq!(reader.wait("onGetRooms").await?[0]["roomId"], ids[1]);
    Ok(())
}
#[tokio::test]
async fn immediate_pong_fences_queued_old_session_callbacks() -> Result<()> {
    let s = Relay::start(json!({"sendDelayMs":400,"heartbeatIntervalMs":20})).await?;
    let mut old = Client::auth(&s.url, json!({"name":"Original"})).await?;
    let mut peer = Client::connect(&s.url).await?;
    let room = old.room(json!({})).await?;
    peer.enter(&room).await?;
    old.wait("playerEnter").await?;
    let timestamp = old.wait("Ping").await?;
    let start = Instant::now();
    old.send("changeName", json!("Stale"))?;
    old.send("sendToRoom", json!("stale"))?;
    old.bytes(b"stale".to_vec())?;
    old.send("getPlayers", json!([peer.id()]))?;
    old.send("Pong", timestamp)?;
    peer.wait_where("RoomRTT", |v| v[old.id()].is_number())
        .await?;
    let mut back = Client::auth(&s.url, old.account.clone()).await?;
    back.wait("onRoomEnter").await?;
    assert!(start.elapsed() < Duration::from_millis(400));
    old.closed().await?;
    assert_eq!(back.barrier().await?.as_array().unwrap().len(), 2);
    back.none("onGetPlayers").await?;
    peer.send("getPlayers", json!([old.id()]))?;
    assert_eq!(peer.wait("onGetPlayers").await?[0]["name"], "Original");
    for name in ["nameChanged", "messageFromPlayer", "binary"] {
        peer.none(name).await?;
    }
    back.send("sendToRoom", json!("fresh"))?;
    assert_eq!(peer.wait("messageFromPlayer").await?["msg"], "fresh");
    Ok(())
}
