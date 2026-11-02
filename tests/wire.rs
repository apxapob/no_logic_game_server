#[path = "../rust/tooling/mod.rs"]
mod support;
use anyhow::Result;
use serde_json::json;
use support::*;
#[tokio::test]
async fn auth_room_binary_session_roundtrip() -> Result<()> {
    let dir = Temp::new();
    let mut server = Relay::start(json!({"sessionDirectory":dir.0})).await?;
    let mut host = Client::connect(&server.url).await?;
    let mut peer = Client::connect(&server.url).await?;
    let room = host.room(json!({"binaryRelay":true})).await?;
    peer.enter(&room).await?;
    host.bytes(packet(Some(peer.id()), &[255, 0, 128]))?;
    let b = peer.binary().await?;
    assert_eq!(&b[1..17], uuid::Uuid::parse_str(host.id())?.as_bytes());
    assert_eq!(&b[17..], &[255, 0, 128]);
    host.send(
        "startGame",
        json!({"fixedRoster":true,"hostMigration":true,"persistent":true}),
    )?;
    host.wait("gameStarted").await?;
    host.save(&vec![42; 100000], 0, 0, json!({})).await?;
    assert_eq!(peer.load().await?.1, vec![42; 100000]);
    server.stop().await?;
    Ok(())
}
#[path = "cases/auth.rs"]
mod auth;
#[path = "cases/limits.rs"]
mod limits;
#[path = "cases/rooms.rs"]
mod rooms;
#[path = "cases/sessions.rs"]
mod sessions;

#[path = "cases/push.rs"]
mod push;

#[path = "cases/logging.rs"]
mod logging;
