use crate::support::*;
use anyhow::Result;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
fn logs(records: Vec<Value>) -> Vec<Value> {
    records
        .iter()
        .filter_map(|r| r["log"].as_str())
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect()
}
#[tokio::test]
async fn verbose_logs_cover_frames_lifecycle_and_redact_without_mutating_traffic() -> Result<()> {
    let mut s = Relay::start(json!({"verboseLogs":true})).await?;
    let mut a = Client::connect(&s.url).await?;
    let mut b = Client::connect(&s.url).await?;
    let r = a.room(json!({"password":"private-room-password"})).await?;
    b.send(
        "enterRoom",
        json!({"roomId":r["roomId"],"password":"private-room-password"}),
    )?;
    b.wait("onRoomEnter").await?;
    a.send("sendToRoom",json!({"text":"hello","nested":[{"accessToken":"hidden-token"}],"password":"hidden-payload-password"}))?;
    assert_eq!(
        b.wait("messageFromPlayer").await?["msg"]["nested"][0]["accessToken"],
        "hidden-token"
    );
    a.bytes(vec![0, 1, 255, 128])?;
    assert_eq!(b.binary().await?, [0, 1, 255, 128]);
    a.frame(Message::Ping(b"probe".to_vec().into()))?;
    a.take("pong").await?;
    let replacement = Client::auth(&s.url, a.account.clone()).await?;
    a.closed().await?;
    replacement.disconnect();
    b.disconnect();
    s.wait_snapshot(|v| v["stats"]["online"] == 0).await?;
    s.stop().await?;
    let rows = logs(s.records().await);
    for event in [
        "transport.connected",
        "connection.connected",
        "authentication.succeeded",
        "room.created",
        "room.entered",
        "room.left",
        "room.deleted",
        "connection.disconnected",
        "server stopped",
    ] {
        assert!(rows.iter().any(|v| v["event"] == event), "{event}");
    }
    let connected = rows
        .iter()
        .find(|v| v["event"] == "connection.connected")
        .unwrap();
    let auth = rows
        .iter()
        .find(|v| v["event"] == "authentication.succeeded")
        .unwrap();
    assert_eq!(connected["connectionId"], auth["connectionId"]);
    assert_eq!(auth["playerId"], a.id());
    assert!(
        rows.iter()
            .all(|v| chrono::DateTime::parse_from_rfc3339(v["time"].as_str().unwrap()).is_ok())
    );
    for direction in ["in", "out"] {
        assert!(rows.iter().any(|v| v["type"] == "binary"
            && v["direction"] == direction
            && v["payload"] == "AAH/gA=="));
        assert!(rows.iter().any(|v| v["type"] == "text"
            && v["direction"] == direction
            && v["payload"].to_string().contains("hello")));
    }
    assert!(
        rows.iter()
            .any(|v| v["type"] == "ping" && v["direction"] == "in")
    );
    assert!(
        rows.iter()
            .any(|v| v["type"] == "pong" && v["direction"] == "out")
    );
    assert!(rows.iter().any(|v| v["reason"] == "session_replaced"));
    let text = json!(rows).to_string();
    for secret in [
        a.account["password"].as_str().unwrap(),
        b.account["password"].as_str().unwrap(),
        "private-room-password",
        "hidden-token",
        "hidden-payload-password",
    ] {
        assert!(!text.contains(secret));
    }
    assert!(text.contains("[REDACTED]"));
    Ok(())
}
#[tokio::test]
async fn rejection_reasons_are_useful_without_url_or_malformed_secrets() -> Result<()> {
    let mut s =
        Relay::start(json!({"verboseLogs":true,"maxMessagesPerSecond":3,"authTimeoutMs":100}))
            .await?;
    assert!(
        Client::raw(&(s.url.clone() + "?password=query-secret"), None)
            .await
            .is_err()
    );
    let mut pending = Client::raw(&s.url, None).await?;
    pending.frame(Message::Text("{\"password\":\"malformed-secret\",".into()))?;
    pending.wait("error").await?;
    pending.closed().await?;
    let mut flood = Client::connect(&s.url).await?;
    for _ in 0..4 {
        flood.send("getRooms", Value::Null)?;
    }
    flood.closed().await?;
    let mut denied = Client::raw(&s.url, None).await?;
    denied.send(
        "authenticate",
        json!({"playerId":flood.id(),"password":"incorrect-secret"}),
    )?;
    denied.wait("wrongPassword").await?;
    denied.closed().await?;
    s.stop().await?;
    let rows = logs(s.records().await);
    for reason in [
        "invalid_path",
        "authentication_timeout",
        "message_rate_limit",
    ] {
        assert!(rows.iter().any(|v| v["reason"] == reason), "{reason}");
    }
    assert!(rows.iter().any(|v| v["event"] == "authentication.failed"));
    assert!(
        rows.iter()
            .any(|v| v["event"] == "protocol.error" && v["code"] == "invalid_message")
    );
    let text = json!(rows).to_string();
    for secret in ["query-secret", "malformed-secret", "incorrect-secret"] {
        assert!(!text.contains(secret));
    }
    Ok(())
}
#[tokio::test]
async fn normal_logs_are_lifecycle_only() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let c = Client::connect(&s.url).await?;
    c.disconnect();
    s.stop().await?;
    let records = s.records().await;
    let rows = records
        .iter()
        .filter_map(|v| v["log"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(rows, ["server started", "server stopped"]);
    Ok(())
}

#[tokio::test]
async fn dev_logging_omits_identifiers_names_and_game_data() -> Result<()> {
    let mut server = Relay::start(json!({"devMode":true})).await?;
    let mut host = Client::auth(&server.url, json!({"name":"CONFIDENTIAL_PLAYER_NAME"})).await?;
    let mut peer = Client::connect(&server.url).await?;
    let room = host.room(json!({"password":"CONFIDENTIAL_ROOM_PASSWORD","gameData":{"secret":"CONFIDENTIAL_GAME_DATA"}})).await?;
    peer.send(
        "enterRoom",
        json!({"roomId":room["roomId"],"password":"CONFIDENTIAL_ROOM_PASSWORD"}),
    )?;
    peer.wait("onRoomEnter").await?;
    host.send("sendChatMsg", json!("CONFIDENTIAL_CHAT_TEXT"))?;
    peer.wait("chatMsg").await?;
    host.send("setRoomMeta", json!({"secret":"CONFIDENTIAL_METADATA"}))?;
    peer.wait("onSetRoomMeta").await?;
    host.send(
        "shareGameState",
        json!({"gamestate":{"secret":"CONFIDENTIAL_GAME_STATE"}}),
    )?;
    peer.wait("newGameState").await?;
    assert!(
        Client::raw(
            &(server.url.clone() + "?password=CONFIDENTIAL_QUERY_PASSWORD"),
            None
        )
        .await
        .is_err()
    );
    host.barrier().await?;
    server.stop().await?;
    let text = server
        .records()
        .await
        .iter()
        .filter_map(|v| v["log"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    for secret in [
        "CONFIDENTIAL",
        host.id(),
        host.account["password"].as_str().unwrap(),
        peer.account["password"].as_str().unwrap(),
    ] {
        assert!(!text.contains(secret));
    }
    Ok(())
}
