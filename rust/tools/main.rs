mod load;
mod local;
mod resources;
#[path = "../tooling/mod.rs"]
mod support;
mod web;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::path::PathBuf;
use support::*;
use tokio_tungstenite::tungstenite::Message;
fn number(key: &str, default: usize, min: usize, max: usize) -> Result<usize> {
    let v = std::env::var(key)
        .ok()
        .map(|v| v.parse())
        .transpose()?
        .unwrap_or(default);
    anyhow::ensure!((min..=max).contains(&v), "{key} must be {min}..={max}");
    Ok(v)
}
fn executable() -> PathBuf {
    std::env::var_os("RUST_SERVER_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe().unwrap().with_file_name(format!(
                "no-logic-game-server{}",
                std::env::consts::EXE_SUFFIX
            ))
        })
}
fn report(path: &str, value: &Value) -> Result<()> {
    let p = PathBuf::from(path);
    if let Some(parent) = p.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(p, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}
async fn connect(url: &str, account: Option<Value>) -> Result<Client> {
    let origin = std::env::var("RELAY_ORIGIN").ok();
    let mut c = Client::raw(url, origin.as_deref()).await?;
    c.heartbeats();
    c.send(
        "authenticate",
        account.clone().unwrap_or(json!({"name":"Relay check"})),
    )?;
    c.account = match account {
        Some(a) => a,
        None => c.wait("accountCreated").await?,
    };
    c.wait("onConnected").await?;
    Ok(c)
}
async fn network(url: &str) -> Result<()> {
    let mut c = connect(url, None).await?;
    let mut samples = vec![];
    for _ in 0..50 {
        let start = std::time::Instant::now();
        c.frame(Message::Ping(b"probe".to_vec().into()))?;
        anyhow::ensure!(
            c.take("pong").await?.into_data() == b"probe"[..],
            "Unexpected pong"
        );
        samples.push(start.elapsed().as_secs_f64() * 1000.);
        sleep(100).await;
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "{}",
        json!({"time":chrono::Utc::now(),"samples":50,"p50Ms":samples[24],"p95Ms":samples[47],"maxMs":samples[49]})
    );
    Ok(())
}
async fn smoke(url: &str) -> Result<()> {
    let mut h = connect(url, None).await?;
    let mut p = connect(url, None).await?;
    let mut t = connect(url, None).await?;
    let r = h
        .room(json!({"name":"Temporary relay check","binaryRelay":true}))
        .await?;
    p.enter(&r).await?;
    t.enter(&r).await?;
    h.send("sendTo", json!({"to":[p.id()],"msg":{"check":"json"}}))?;
    assert_eq!(p.wait("messageFromPlayer").await?["msg"]["check"], "json");
    let bytes = (0..32000).map(|_| rand::random::<u8>()).collect::<Vec<_>>();
    h.bytes(packet(Some(p.id()), &bytes))?;
    let received = p.binary().await?;
    assert_eq!(&received[1..17], uuid::Uuid::parse_str(h.id())?.as_bytes());
    assert_eq!(received[17..], bytes);
    h.bytes(packet(None, &bytes))?;
    assert_eq!(p.binary().await?[17..], bytes);
    assert_eq!(t.binary().await?[17..], bytes);
    h.send(
        "startGame",
        json!({"fixedRoster":true,"hostMigration":true}),
    )?;
    p.wait("gameStarted").await?;
    h.disconnect();
    assert_eq!(p.wait("newRoomOwner").await?["playerId"], p.id());
    let mut resumed = connect(url, Some(h.account.clone())).await?;
    assert_eq!(resumed.enter(&r).await?["hostGeneration"], 1);
    for c in [&mut p, &mut t, &mut resumed] {
        c.send("leaveRoom", Value::Null)?;
        c.barrier().await?;
    }
    let legacy = p.room(json!({"name":"Temporary legacy check"})).await?;
    t.enter(&legacy).await?;
    let mut raw = vec![0xf8];
    raw.extend(bytes);
    p.bytes(raw.clone())?;
    assert_eq!(t.binary().await?, raw);
    for c in [&mut p, &mut t] {
        c.send("leaveRoom", Value::Null)?;
        c.barrier().await?;
    }
    println!(
        "{}",
        json!({"time":chrono::Utc::now(),"json":true,"targetedBinary":true,"broadcastBinary":true,"legacyBinary":true,"hostMigration":true,"rejoin":true,"roomsLeft":true})
    );
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("demo") => web::demo().await,
        Some("memory") => local::memory().await,
        Some("benchmark") => local::benchmark().await,
        Some("loadtest") => {
            load::run(
                args.get(1)
                    .ok_or_else(|| anyhow::anyhow!("Pass a JSON config path"))?,
            )
            .await
        }
        Some("smoke") | Some("network-baseline") => {
            let url = args
                .get(1)
                .ok_or_else(|| anyhow::anyhow!("Pass an authorized ws:// or wss:// endpoint"))?;
            anyhow::ensure!(
                url.starts_with("ws://") || url.starts_with("wss://"),
                "Expected WebSocket URL"
            );
            if args[0] == "smoke" {
                smoke(url).await
            } else {
                network(url).await
            }
        }
        Some("--help") | None => {
            println!(
                "relay-tool demo | memory | benchmark | loadtest CONFIG.json | smoke URL | network-baseline URL\nSee README for environment settings. Network commands only target the supplied endpoint."
            );
            Ok(())
        }
        _ => bail!("Unknown command; run relay-tool --help"),
    }
}
