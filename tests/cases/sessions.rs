use crate::support::*;
use anyhow::Result;
use serde_json::{Value, json};
use std::fs;
fn options(dir: &Temp) -> Value {
    json!({"sessionDirectory":dir.0,"maintenanceIntervalMs":1000})
}
#[tokio::test]
async fn last_departure_persists_credentials_roster_and_opaque_world() -> Result<()> {
    let dir = Temp::new();
    let (mut s, mut host, mut guest, room) = game(options(&dir)).await?;
    let bytes: Vec<u8> = (0..100000).map(|_| rand::random()).collect();
    host.save(&bytes, 0, 0, json!({})).await?;
    let file = dir
        .0
        .join("rooms")
        .join(format!("{}.bin", room["roomId"].as_str().unwrap()));
    assert!(!file.exists());
    host.send("leaveRoom", Value::Null)?;
    guest.wait("newRoomOwner").await?;
    assert!(!file.exists());
    guest.send("leaveRoom", Value::Null)?;
    s.wait_snapshot(|v| v["stats"]["rooms"] == 0).await?;
    assert!(file.exists());
    s.stop().await?;
    let mut next = Relay::start(options(&dir)).await?;
    let mut back = Client::auth(&next.url, guest.account.clone()).await?;
    back.send("getSavedRooms", json!({"ids":[room["roomId"]]}))?;
    assert_eq!(back.wait("savedRoom").await?["room"]["players"], json!([]));
    assert_eq!(next.sync().await?["stats"]["rooms"], 0);
    let entered = back.enter(&room).await?;
    assert_eq!(entered["ownerId"], guest.id());
    assert_eq!(entered["participants"].as_array().unwrap().len(), 2);
    let (info, restored) = back.load().await?;
    assert_eq!(restored, bytes);
    assert_eq!(info["revision"], 1);
    assert_eq!(info["startData"]["example"], "opaque bootstrap");
    let mut outsider = Client::connect(&next.url).await?;
    outsider.send("getSavedRooms", json!({"ids":[room["roomId"]]}))?;
    assert!(outsider.wait("savedRoom").await?["room"].is_null());
    Ok(())
}
#[tokio::test]
async fn partial_stale_repeated_and_expired_uploads_never_replace_committed_state() -> Result<()> {
    let dir = Temp::new();
    let (mut s, mut host, mut guest, room) = game(options(&dir)).await?;
    host.save(b"confirmed", 0, 0, json!({})).await?;
    host.reply(
        "beginSession",
        json!({"size":100,"revision":1,"generation":0}),
    )
    .await?;
    host.send("leaveRoom", Value::Null)?;
    let generation = guest.wait("newRoomOwner").await?["generation"]
        .as_u64()
        .unwrap();
    assert_eq!(guest.load().await?.1, b"confirmed");
    assert_eq!(
        guest
            .reply(
                "beginSession",
                json!({"size":10,"revision":1,"generation":0})
            )
            .await?["error"],
        "stale_session"
    );
    guest
        .save(b"new confirmed", 1, generation, json!({}))
        .await?;
    assert_eq!(
        guest
            .reply(
                "beginSession",
                json!({"size":10,"revision":1,"generation":generation})
            )
            .await?["error"],
        "stale_session"
    );
    host.enter(&room).await?;
    assert_eq!(
        host.reply(
            "beginSession",
            json!({"size":10,"revision":2,"generation":generation})
        )
        .await?["error"],
        "not_room_owner"
    );
    let id = uuid::Uuid::new_v4();
    guest
        .reply(
            "beginSession",
            json!({"requestId":id.to_string(),"size":10,"revision":2,"generation":generation}),
        )
        .await?;
    guest.bytes(chunk(id, 0, &[0; 5]))?;
    guest.wait("sessionReply").await?;
    guest.bytes(chunk(id, 0, &[0; 5]))?;
    assert_eq!(guest.wait("sessionReply").await?["error"], "stale_session");
    assert_eq!(guest.load().await?.1, b"new confirmed");
    guest
        .reply(
            "beginSession",
            json!({"size":10,"revision":2,"generation":generation}),
        )
        .await?;
    s.control(json!({"uploadAt":{"id":room["roomId"],"at":now()-31000}}))
        .await?;
    s.wait_snapshot(|v| v["rooms"][0][1]["upload"].is_null())
        .await?;
    assert_eq!(guest.load().await?.1, b"new confirmed");
    guest
        .save(&vec![17; 125000], 2, generation, json!({}))
        .await?;
    Ok(())
}
#[tokio::test]
async fn graceful_stop_flushes_active_world_and_accounts_outlive_memory_ttl() -> Result<()> {
    let dir = Temp::new();
    let (mut s, mut host, guest, room) =
        game(json!({"sessionDirectory":dir.0,"accountTtlMs":1,"maintenanceIntervalMs":1000}))
            .await?;
    host.save(b"shutdown", 0, 0, json!({})).await?;
    s.stop().await?;
    let next = Relay::start(options(&dir)).await?;
    let mut back = Client::auth(&next.url, host.account.clone()).await?;
    back.enter(&room).await?;
    assert_eq!(back.load().await?.1, b"shutdown");
    let mut peer = Client::auth(&next.url, guest.account.clone()).await?;
    peer.enter(&room).await?;
    Ok(())
}
#[tokio::test]
async fn disk_failure_retains_authoritative_world_then_retries() -> Result<()> {
    let dir = Temp::new();
    let (mut s, mut host, mut guest, room) =
        game(json!({"sessionDirectory":dir.0,"maintenanceIntervalMs":50})).await?;
    let bytes = vec![71; 90000];
    host.save(&bytes, 0, 0, json!({})).await?;
    let file = dir
        .0
        .join("rooms")
        .join(format!("{}.bin", room["roomId"].as_str().unwrap()));
    let blocker = file.with_extension("bin.tmp");
    fs::create_dir(&blocker)?;
    host.send("leaveRoom", Value::Null)?;
    guest.send("leaveRoom", Value::Null)?;
    let retained = s
        .wait_snapshot(|v| {
            v["rooms"]
                .as_array()
                .is_some_and(|a| a.len() == 1 && a[0][1]["active"] == json!([]))
        })
        .await?;
    assert_eq!(retained["stats"]["rooms"], 1);
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(retained["rooms"][0][1]["sessionState"].as_str().unwrap())?,
        bytes
    );
    assert!(!file.exists());
    fs::remove_dir(blocker)?;
    s.wait_snapshot(|v| v["stats"]["rooms"] == 0).await?;
    guest.enter(&room).await?;
    assert_eq!(guest.load().await?.1, bytes);
    Ok(())
}
#[tokio::test]
async fn notification_storage_failure_leaves_revision_and_state_unchanged() -> Result<()> {
    let dir = Temp::new();
    let (_s, mut host, _guest, room) = game(options(&dir)).await?;
    host.save(b"confirmed", 0, 0, json!({})).await?;
    let blocker = dir
        .0
        .join("notifications")
        .join(format!("{}.json.tmp", room["roomId"].as_str().unwrap()));
    fs::create_dir(&blocker)?;
    let id = uuid::Uuid::new_v4();
    host.reply(
        "beginSession",
        json!({"requestId":id.to_string(),"size":1,"revision":1,"generation":0}),
    )
    .await?;
    host.bytes(chunk(id, 0, &[0]))?;
    host.wait("sessionReply").await?;
    let result=host.reply("commitSession",json!({"requestId":id.to_string(),"immediate":null,"scheduled":{"eventId":"deadline","at":now()+10000,"to":[],"title":"G","body":"Time"}})).await?;
    assert_eq!(result["error"], "storage_error");
    let (info, bytes) = host.load().await?;
    assert_eq!(info["revision"], 1);
    assert_eq!(bytes, b"confirmed");
    fs::remove_dir(blocker)?;
    host.save(b"recovered", 1, 0, json!({})).await?;
    Ok(())
}
#[tokio::test]
async fn sleeping_world_headers_and_all_200_payloads_survive_restart() -> Result<()> {
    let dir = Temp::new();
    let mut setup = Relay::start(options(&dir)).await?;
    let owner = Client::auth(&setup.url, json!({"name":"Capacity"})).await?;
    let credentials = owner.account.clone();
    setup.stop().await?;
    let bytes = vec![21; 100000];
    let mut ids = vec![];
    for i in 0..200 {
        let id = uuid();
        let header=json!({"version":1,"roomId":id,"name":format!("room-{i}"),"ownerId":owner.id(),"maxPlayers":3,"password":null,"gameData":null,"metaData":null,"startData":null,"players":[owner.id()],"generation":0,"binaryRelay":true,"revision":i+1,"updatedAt":1000+i,"events":[]}).to_string();
        let mut b = (header.len() as u32).to_be_bytes().to_vec();
        b.extend(header.as_bytes());
        b.extend(&bytes);
        fs::write(dir.0.join("rooms").join(format!("{id}.bin")), b)?;
        ids.push(id);
    }
    let mut s = Relay::start(
        json!({"sessionDirectory":dir.0,"maxMessagesPerSecond":10000,"maintenanceIntervalMs":1000}),
    )
    .await?;
    let mut c = Client::auth(&s.url, credentials).await?;
    for batch in ids.chunks(20) {
        c.send("getSavedRooms", json!({"ids":batch}))?;
        for id in batch {
            let room = c
                .wait_where("savedRoom", |v| v["roomId"] == id.as_str())
                .await?;
            assert!(room["room"].is_object());
        }
        assert_eq!(s.sync().await?["stats"]["rooms"], 0);
    }
    for (i, id) in ids.iter().enumerate() {
        let stored = fs::read(dir.0.join("rooms").join(format!("{id}.bin")))?;
        let n = u32::from_be_bytes(stored[..4].try_into().unwrap()) as usize;
        let header: Value = serde_json::from_slice(&stored[4..4 + n])?;
        assert_eq!(header["revision"], i + 1);
        assert_eq!(&stored[4 + n..], bytes);
    }
    c.enter(&json!({"roomId":ids[37]})).await?;
    assert_eq!(c.load().await?.1, bytes);
    assert_eq!(s.sync().await?["stats"]["rooms"], 1);
    c.send("leaveRoom", Value::Null)?;
    s.wait_snapshot(|v| v["stats"]["rooms"] == 0).await?;
    Ok(())
}
#[tokio::test]
async fn corrupt_room_isolated_and_saved_rooms_never_mix_worlds() -> Result<()> {
    let dir = Temp::new();
    let (mut s, mut host, mut guest, first) = game(options(&dir)).await?;
    host.save(b"first", 0, 0, json!({})).await?;
    host.send("leaveRoom", Value::Null)?;
    guest.send("leaveRoom", Value::Null)?;
    s.wait_snapshot(|v| v["stats"]["rooms"] == 0).await?;
    let corrupt = uuid();
    fs::write(dir.0.join("rooms").join(format!("{corrupt}.bin")), [0, 0])?;
    host.send("getSavedRooms", json!({"ids":[corrupt]}))?;
    host.wait("error").await?;
    host.send("getSavedRooms", json!({"ids":[uuid(),first["roomId"]]}))?;
    assert!(host.wait("savedRoom").await?["room"].is_null());
    assert!(host.wait("savedRoom").await?["room"].is_object());
    let second = host.room(json!({"binaryRelay":true})).await?;
    host.send(
        "startGame",
        json!({"fixedRoster":true,"hostMigration":true,"persistent":true}),
    )?;
    host.wait("gameStarted").await?;
    host.save(b"second", 0, 0, json!({})).await?;
    host.send("leaveRoom", Value::Null)?;
    s.wait_snapshot(|v| v["stats"]["rooms"] == 0).await?;
    guest.send(
        "getSavedRooms",
        json!({"ids":[first["roomId"],second["roomId"]]}),
    )?;
    assert!(guest.wait("savedRoom").await?["room"].is_object());
    assert!(guest.wait("savedRoom").await?["room"].is_null());
    for (room, expected) in [
        (&first, b"first".as_slice()),
        (&second, b"second".as_slice()),
        (&first, b"first".as_slice()),
    ] {
        host.enter(room).await?;
        let (info, bytes) = host.load().await?;
        assert_eq!(info["revision"], 1);
        assert_eq!(bytes, expected);
        host.send("leaveRoom", Value::Null)?;
        s.wait_snapshot(|v| v["stats"]["rooms"] == 0).await?;
    }
    Ok(())
}
#[tokio::test]
async fn hard_kill_keeps_sleeping_save_and_rolls_back_unflushed_active_changes() -> Result<()> {
    let dir = Temp::new();
    let (mut s, mut host, guest, room) = game(options(&dir)).await?;
    let credentials = host.account.clone();
    host.save(b"sleeping", 0, 0, json!({})).await?;
    host.send("leaveRoom", Value::Null)?;
    guest.send("leaveRoom", Value::Null)?;
    s.wait_snapshot(|v| v["stats"]["rooms"] == 0).await?;
    s.kill().await?;
    let mut s = Relay::start(options(&dir)).await?;
    let mut host = Client::auth(&s.url, credentials.clone()).await?;
    let entered = host.enter(&room).await?;
    assert_eq!(host.load().await?.1, b"sleeping");
    host.save(
        b"active not flushed",
        1,
        entered["hostGeneration"].as_u64().unwrap(),
        json!({}),
    )
    .await?;
    s.kill().await?;
    let s = Relay::start(options(&dir)).await?;
    let mut host = Client::auth(&s.url, credentials).await?;
    let entered = host.enter(&room).await?;
    let (info, bytes) = host.load().await?;
    assert_eq!(info["revision"], 1);
    assert_eq!(bytes, b"sleeping");
    host.save(
        b"continued",
        1,
        entered["hostGeneration"].as_u64().unwrap(),
        json!({}),
    )
    .await?;
    Ok(())
}
