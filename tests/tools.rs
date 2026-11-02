#[cfg(not(unix))]
use tokio::io::AsyncWriteExt;
#[path = "../rust/tooling/mod.rs"]
mod support;
use anyhow::Result;
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use support::*;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
fn file_logs(path: &std::path::Path) -> Result<(usize, usize, Vec<Value>)> {
    let mut entries = std::fs::read_dir(path)?.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    let mut bytes = 0;
    let mut records = vec![];
    let mut count = 0;
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("server-") || !name.ends_with(".jsonl") {
            continue;
        }
        count += 1;
        let text = std::fs::read_to_string(entry.path())?;
        bytes += text.len();
        for line in text.lines().filter(|l| !l.is_empty()) {
            records.push(serde_json::from_str(line)?);
        }
    }
    Ok((count, bytes, records))
}
#[tokio::test]
async fn real_cli_rotates_files_flushes_and_keeps_stdout_empty() -> Result<()> {
    let dir = Temp::new();
    let mut child = Command::new(env!("CARGO_BIN_EXE_no-logic-game-server"))
        .env_remove("RELAY_TEST_CONTROL")
        .envs([
            ("HOST", "127.0.0.1"),
            ("PORT", "0"),
            ("SESSION_DIRECTORY", ""),
            ("TELEMETRY_ENABLED", "false"),
            ("FCM_ENABLED", "false"),
            ("VERBOSE_LOGS", "true"),
            ("LOG_MAX_BYTES", "4096"),
            ("LOG_FILE_MAX_BYTES", "512"),
            ("ALLOW_NO_ORIGIN", "true"),
            ("SEND_DELAY_MS", "0"),
        ])
        .env("LOG_DIRECTORY", &dir.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let port = tokio::time::timeout(WAIT, async {
        loop {
            if let Ok((_, _, rows)) = file_logs(&dir.0)
                && let Some(port) = rows
                    .iter()
                    .find(|v| v["event"] == "server.listening")
                    .and_then(|v| v["address"]["port"].as_u64())
            {
                break port;
            }
            sleep(10).await;
        }
    })
    .await?;
    let mut c = Client::connect(&format!("ws://127.0.0.1:{port}/")).await?;
    c.room(json!({})).await?;
    for _ in 0..30 {
        c.send("getRooms", Value::Null)?;
    }
    c.barrier().await?;
    c.disconnect();
    tokio::time::timeout(WAIT, async {
        loop {
            if file_logs(&dir.0)
                .is_ok_and(|(_, _, v)| v.iter().any(|r| r["event"] == "connection.disconnected"))
            {
                break;
            }
            sleep(10).await;
        }
    })
    .await?;
    assert!(child.try_wait()?.is_none());
    #[cfg(unix)]
    {
        assert!(
            Command::new("kill")
                .args(["-TERM", &child.id().unwrap().to_string()])
                .status()
                .await?
                .success()
        );
    }
    #[cfg(not(unix))]
    {
        child.stdin.take().unwrap().write_all(b"stop\n").await?;
    }
    let output = tokio::time::timeout(WAIT, child.wait_with_output()).await??;
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    let (count, bytes, rows) = file_logs(&dir.0)?;
    assert!(count > 1);
    assert!(bytes <= 4096);
    assert!(rows.iter().any(|v| v["event"] == "message"));
    assert!(rows.iter().all(|v| v["event"] != "server.listening"));
    assert_eq!(rows.last().unwrap()["event"], "server stopped");
    Ok(())
}
#[tokio::test]
async fn demo_only_serves_allowlisted_html() -> Result<()> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay-tool"))
        .arg("demo")
        .env("DEMO_PORT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(WAIT, lines.next_line())
        .await??
        .unwrap();
    let url = line.strip_prefix("Demo: ").unwrap();
    let http = reqwest::Client::new();
    let root = http.get(url).send().await?;
    assert_eq!(root.status(), 200);
    assert_eq!(root.text().await?, include_str!("../demo.html"));
    let head = http.head(format!("{url}/demo.html")).send().await?;
    assert_eq!(head.status(), 200);
    assert_eq!(
        head.headers()["content-length"],
        include_str!("../demo.html").len().to_string()
    );
    assert!(head.bytes().await?.is_empty());
    for path in ["/pass", "/Cargo.toml", "/../pass", "/demo.html?x=1"] {
        assert_eq!(http.get(format!("{url}{path}")).send().await?.status(), 404);
    }
    assert_eq!(http.post(url).send().await?.status(), 405);
    child.kill().await?;
    Ok(())
}
#[tokio::test]
async fn rust_remote_tools_work_against_isolated_local_relay() -> Result<()> {
    let dir = Temp::new();
    let mut server = Relay::production(
        env!("CARGO_BIN_EXE_no-logic-game-server").into(),
        json!({"maxConnectionsPerMinute":1000,"maxMessagesPerSecond":10000}),
    )
    .await?;
    for mode in ["smoke", "network-baseline"] {
        let out = tokio::time::timeout(
            Duration::from_secs(30),
            Command::new(env!("CARGO_BIN_EXE_relay-tool"))
                .args([mode, &server.url])
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let row: Value = serde_json::from_slice(&out.stdout)?;
        if mode == "smoke" {
            assert_eq!(row["hostMigration"], true);
        } else {
            assert_eq!(row["samples"], 50);
        }
    }
    let path = dir.0.join("load.json");
    let output = dir.0.join("results.jsonl");
    std::fs::write(&path,json!({"url":server.url,"output":output,"profile":"integration","levels":[4,8],"roomSize":4,"hz":20,"stateBytes":512,"inputBytes":128,"warmupSeconds":1,"durationSeconds":1,"rampPauseMs":0}).to_string())?;
    let result = tokio::time::timeout(
        Duration::from_secs(45),
        Command::new(env!("CARGO_BIN_EXE_relay-tool"))
            .arg("loadtest")
            .arg(path)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let rows = std::fs::read_to_string(output)?
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let stages = rows
        .iter()
        .filter(|v| v["event"] == "stage")
        .collect::<Vec<_>>();
    assert_eq!(stages.len(), 2);
    for row in stages {
        assert_eq!(row["deliveryPercent"], 100.);
        assert_eq!(row["duplicates"], 0);
        assert!(row["offeredRatePercent"].as_f64().unwrap() >= 95.);
    }
    server.stop().await
}

#[tokio::test]
async fn broken_log_sink_does_not_break_relay() -> Result<()> {
    let dir = Temp::new();
    let blocker = dir.0.join("not-a-directory");
    std::fs::write(&blocker, b"block logger directory")?;
    let reservation = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = reservation.local_addr()?.port();
    drop(reservation);
    let mut child = Command::new(env!("CARGO_BIN_EXE_no-logic-game-server"))
        .env_remove("RELAY_TEST_CONTROL")
        .envs([
            ("HOST", "127.0.0.1"),
            ("SESSION_DIRECTORY", ""),
            ("TELEMETRY_ENABLED", "false"),
            ("FCM_ENABLED", "false"),
            ("VERBOSE_LOGS", "true"),
        ])
        .env("PORT", port.to_string())
        .env("LOG_DIRECTORY", blocker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let url = format!("ws://127.0.0.1:{port}/");
    let mut client = tokio::time::timeout(WAIT, async {
        loop {
            match Client::connect(&url).await {
                Ok(c) => break c,
                Err(_) => sleep(10).await,
            }
        }
    })
    .await?;
    client.room(json!({})).await?;
    assert!(!client.barrier().await?.as_array().unwrap().is_empty());
    tokio::io::AsyncWriteExt::write_all(&mut child.stdin.take().unwrap(), b"stop\n").await?;
    let out = tokio::time::timeout(WAIT, child.wait_with_output()).await??;
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("File logging failed"));
    Ok(())
}
