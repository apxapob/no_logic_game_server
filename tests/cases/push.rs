use crate::support::*;
use anyhow::Result;
use serde_json::{Value, json};
const TOKEN: &str = "test-token-123456789012345678901234567890";
async fn register(
    c: &mut Client,
    id: &str,
    token: Value,
    foreground: bool,
    language: &str,
) -> Result<()> {
    c.send(
        "setPushDevice",
        json!({"deviceId":id,"token":token,"foreground":foreground,"language":language}),
    )?;
    c.wait("pushDeviceUpdated").await?;
    Ok(())
}
fn notice(c: &Client, event: &str, at: u64) -> Value {
    json!({"to":[c.id()],"eventId":event,"at":at,"title":"Default","body":"Fallback"})
}
async fn setup(mock: &MockPush, dir: &Temp) -> Result<(Relay, Client, Client, Value)> {
    game(json!({"sessionDirectory":dir.0,"fcmEnabled":true,"relayTestPushUrl":mock.url})).await
}
#[tokio::test]
async fn devices_localize_independently_and_validate_language() -> Result<()> {
    let mock = MockPush::start(|_, _| (200, json!({"result":"sent"}))).await?;
    let dir = Temp::new();
    let (mut s, h, mut g, _) = setup(&mock, &dir).await?;
    let ids = [uuid(), uuid(), uuid(), uuid()];
    for (i, lang) in ["en", "de", "pt-BR", "it"].iter().enumerate() {
        register(&mut g, &ids[i], json!(format!("{TOKEN}-{i}")), false, lang).await?;
    }
    register(&mut g, &ids[0], json!(format!("{TOKEN}-0")), false, "ru").await?;
    let mut n = notice(&g, "localized", 0);
    for lang in [
        "en", "ru", "de", "es", "fr", "ja", "ko", "pl", "pt-BR", "zh-CN",
    ] {
        n["translations"][lang] =
            json!({"title":format!("Title {lang}"),"body":format!("Body {lang}")});
    }
    h.send("notifyPlayers", n)?;
    let mut bodies = mock
        .wait(4)
        .await?
        .iter()
        .map(|v| v["notification"]["body"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    bodies.sort();
    assert_eq!(bodies, vec!["Body de", "Body pt-BR", "Body ru", "Fallback"]);
    g.error(
        "setPushDevice",
        json!({"deviceId":ids[0],"token":TOKEN,"foreground":false,"language":"../ru"}),
        "invalid_message",
    )
    .await?;
    s.stop().await
}
#[tokio::test]
async fn push_dedup_rate_limit_permissions_and_private_tokens() -> Result<()> {
    let mock = MockPush::start(|_, _| (200, json!({"result":"sent"}))).await?;
    let mut s =
        Relay::start(json!({"fcmEnabled":true,"relayTestPushUrl":mock.url,"verboseLogs":true}))
            .await?;
    let mut h = Client::connect(&s.url).await?;
    let mut g = Client::connect(&s.url).await?;
    let outside = Client::connect(&s.url).await?;
    let r = h.room(json!({})).await?;
    g.enter(&r).await?;
    register(&mut g, &uuid(), json!(TOKEN), false, "en").await?;
    h.send("startGame", json!({"fixedRoster":true}))?;
    h.wait("gameStarted").await?;
    h.send("notifyPlayers", notice(&g, "turn.1", 0))?;
    let rows = mock.wait(1).await?;
    assert_eq!(rows[0]["token"], TOKEN);
    assert_eq!(rows[0]["notification"]["roomId"], r["roomId"]);
    h.send("notifyPlayers", notice(&g, "turn.1", 0))?;
    assert!(!h.barrier().await?.to_string().contains(TOKEN));
    h.error(
        "notifyPlayers",
        notice(&g, "turn.2", 0),
        "push_rate_limited",
    )
    .await?;
    g.error("notifyPlayers", notice(&h, "other", 0), "not_room_owner")
        .await?;
    h.error(
        "notifyPlayers",
        notice(&outside, "other", 0),
        "invalid_message",
    )
    .await?;
    sleep(40).await;
    assert_eq!(mock.records().await.len(), 1);
    s.stop().await?;
    assert!(
        !s.records()
            .await
            .iter()
            .filter_map(|r| r["log"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .contains(TOKEN)
    );
    Ok(())
}
#[tokio::test]
async fn foreground_revoked_rotated_disconnected_and_failed_provider() -> Result<()> {
    for scenario in ["foreground", "revoked", "rotated", "disconnected"] {
        let fail = scenario == "disconnected";
        let mock = MockPush::start(move |_, _| {
            if fail {
                (503, json!({"error":"unavailable"}))
            } else {
                (200, json!({"result":"sent"}))
            }
        })
        .await?;
        let dir = Temp::new();
        let (mut s, mut h, mut g, _) = setup(&mock, &dir).await?;
        let id = uuid();
        register(
            &mut g,
            &id,
            json!(TOKEN),
            scenario == "foreground" || fail,
            "en",
        )
        .await?;
        if scenario == "revoked" {
            register(&mut g, &id, Value::Null, false, "en").await?;
        }
        if scenario == "rotated" {
            register(&mut g, &id, json!(format!("{TOKEN}-new")), false, "en").await?;
        }
        if fail {
            g.disconnect();
            h.wait("playerDisconnected").await?;
        }
        h.send("notifyPlayers", notice(&g, "turn", 0))?;
        h.barrier().await?;
        if fail || scenario == "rotated" {
            let rows = mock.wait(1).await?;
            if !fail {
                assert_eq!(rows[0]["token"], format!("{TOKEN}-new"));
            }
        } else {
            sleep(40).await;
            assert!(mock.records().await.is_empty());
        }
        s.stop().await?;
    }
    Ok(())
}
#[tokio::test]
async fn disabled_push_and_bad_tokens() -> Result<()> {
    let mut s = Relay::start(json!({})).await?;
    let mut c = Client::raw(&s.url, None).await?;
    c.send("authenticate", json!({}))?;
    c.wait("accountCreated").await?;
    assert!(
        !c.wait("onConnected")
            .await?
            .to_string()
            .contains("pushNotifications")
    );
    for (token, code) in [("bad\n", "invalid_message"), (TOKEN, "push_unavailable")] {
        c.error(
            "setPushDevice",
            json!({"deviceId":uuid(),"token":token,"foreground":false}),
            code,
        )
        .await?;
    }
    s.stop().await
}
#[tokio::test]
async fn offline_deadlines_replace_cancel_localize_and_dedup_across_restart() -> Result<()> {
    let mock = MockPush::start(|_, _| (200, json!({"result":"sent"}))).await?;
    let dir = Temp::new();
    let (mut s, mut h, mut g, _) = setup(&mock, &dir).await?;
    register(&mut g, &uuid(), json!(TOKEN), false, "ru").await?;
    let mut n = notice(&g, "new", now() + 10000);
    n["translations"] = json!({"ru":{"title":"G","body":"localized"}});
    h.save(b"first", 0, 0, json!({"scheduled":n})).await?;
    h.save(b"cancelled", 1, 0, json!({})).await?;
    assert!(s.sync().await?["jobs"].as_object().unwrap().is_empty());
    n["at"] = json!(now() + 300);
    h.save(b"new", 2, 0, json!({"scheduled":n})).await?;
    s.stop().await?;
    let options = json!({"sessionDirectory":dir.0,"fcmEnabled":true,"relayTestPushUrl":mock.url});
    let mut next = Relay::start(options.clone()).await?;
    assert_eq!(mock.wait(1).await?[0]["notification"]["body"], "localized");
    assert_eq!(next.sync().await?["stats"]["rooms"], 0);
    next.stop().await?;
    let mut third = Relay::start(options).await?;
    sleep(200).await;
    assert_eq!(mock.records().await.len(), 1);
    third.stop().await
}
#[tokio::test]
async fn retry_persists_and_foreground_in_another_room_is_eligible() -> Result<()> {
    let mock = MockPush::start(|_, i| {
        if i == 1 {
            (503, json!({"error":"temporary"}))
        } else {
            (200, json!({"result":"sent"}))
        }
    })
    .await?;
    let dir = Temp::new();
    let (mut s, mut h, mut g, r) = setup(&mock, &dir).await?;
    register(&mut g, &uuid(), json!(TOKEN), true, "en").await?;
    g.send("leaveRoom", Value::Null)?;
    h.wait("playerLeft").await?;
    g.room(json!({})).await?;
    h.save(b"result", 0, 0, json!({"immediate":notice(&g,"turn.2",0)}))
        .await?;
    mock.wait(1).await?;
    let id = r["roomId"].as_str().unwrap();
    s.wait_snapshot(|v| {
        v["jobs"][id][0]["retryAt"]
            .as_u64()
            .is_some_and(|t| t > now())
    })
    .await?;
    s.stop().await?;
    let path = dir.0.join("notifications").join(format!("{id}.json"));
    let mut jobs: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    jobs[0]["retryAt"] = json!(0);
    std::fs::write(path, jobs.to_string())?;
    let mut next = Relay::start(
        json!({"sessionDirectory":dir.0,"fcmEnabled":true,"relayTestPushUrl":mock.url}),
    )
    .await?;
    assert_eq!(mock.wait(2).await?[1]["notification"]["eventId"], "turn.2");
    assert_eq!(next.sync().await?["stats"]["rooms"], 0);
    next.stop().await
}
#[tokio::test]
async fn clearing_deadline_prevents_offline_delivery() -> Result<()> {
    let mock = MockPush::start(|_, _| (200, json!({"result":"sent"}))).await?;
    let dir = Temp::new();
    let (mut s, mut h, mut g, _) = setup(&mock, &dir).await?;
    register(&mut g, &uuid(), json!(TOKEN), false, "en").await?;
    h.save(
        b"running",
        0,
        0,
        json!({"scheduled":notice(&g,"deadline",now()+200)}),
    )
    .await?;
    h.save(b"paused", 1, 0, json!({})).await?;
    h.send("leaveRoom", Value::Null)?;
    g.send("leaveRoom", Value::Null)?;
    s.wait_snapshot(|v| v["stats"]["rooms"] == 0).await?;
    sleep(250).await;
    assert!(mock.records().await.is_empty());
    s.stop().await
}
#[tokio::test]
async fn multidevice_delivery_retries_only_failure_and_removes_invalid_tokens() -> Result<()> {
    let failed = std::sync::atomic::AtomicBool::new(false);
    let mock = MockPush::start(move |v, _| {
        let t = v["token"].as_str().unwrap();
        if t.starts_with("invalid") {
            (200, json!({"result":"invalid"}))
        } else if t.starts_with("retry") && !failed.swap(true, std::sync::atomic::Ordering::Relaxed)
        {
            (503, json!({"error":"temporary"}))
        } else {
            (200, json!({"result":"sent"}))
        }
    })
    .await?;
    let dir = Temp::new();
    let (mut s, mut h, mut g, r) = setup(&mock, &dir).await?;
    let ids = [uuid(), uuid(), uuid()];
    for (i, prefix) in ["healthy", "invalid", "retry"].iter().enumerate() {
        register(
            &mut g,
            &ids[i],
            json!(format!("{prefix}-{TOKEN}")),
            false,
            "en",
        )
        .await?;
    }
    let n = notice(&g, "multi-device", 0);
    h.save(b"new", 0, 0, json!({"immediate":n})).await?;
    mock.wait(3).await?;
    let id = r["roomId"].as_str().unwrap();
    s.wait_snapshot(|v| {
        v["jobs"][id][0]["retryAt"]
            .as_u64()
            .is_some_and(|t| t > now())
    })
    .await?;
    s.control(json!({"jobRetry":{"id":id,"index":0,"at":0}}))
        .await?;
    let rows = mock.wait(4).await?;
    assert!(rows[3]["token"].as_str().unwrap().starts_with("retry"));
    s.wait_snapshot(|v| v["jobs"].get(id).is_none()).await?;
    let account = std::fs::read_to_string(dir.0.join("accounts").join(format!("{}.json", g.id())))?;
    assert!(!account.contains(&ids[1]));
    h.save(b"same", 1, 0, json!({"immediate":n})).await?;
    sleep(50).await;
    assert_eq!(mock.records().await.len(), 4);
    s.stop().await
}
#[tokio::test]
async fn corrupt_notification_files_are_isolated() -> Result<()> {
    let dir = Temp::new();
    let path = dir.0.join("notifications");
    std::fs::create_dir_all(&path)?;
    let healthy = uuid();
    std::fs::write(path.join(format!("{healthy}.json")),json!([{"eventId":"valid","at":0,"to":[],"title":"G","body":"T","done":[],"retryAt":0,"scheduled":true}]).to_string())?;
    for text in ["{", "{}"] {
        std::fs::write(path.join(format!("{}.json", uuid())), text)?;
    }
    let mock = MockPush::start(|_, _| (200, json!({"result":"sent"}))).await?;
    let mut s = Relay::start(
        json!({"sessionDirectory":dir.0,"fcmEnabled":true,"relayTestPushUrl":mock.url}),
    )
    .await?;
    s.wait_snapshot(|v| v["jobs"][&healthy][0]["retryAt"] == 9007199254740991u64)
        .await?;
    assert_eq!(
        s.records()
            .await
            .iter()
            .filter(|v| v.to_string().contains("notification file"))
            .count(),
        2
    );
    s.stop().await
}
