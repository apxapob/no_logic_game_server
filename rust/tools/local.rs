use super::*;
use std::time::{Duration, Instant};
pub async fn memory() -> Result<()> {
    let cycles = number("CHURN_CYCLES", 30, 1, 1000)?;
    let count = number("CHURN_CLIENTS", 64, 4, 10000)?;
    anyhow::ensure!(
        count.is_multiple_of(4),
        "CHURN_CLIENTS must be divisible by four"
    );
    let size = number("CHURN_STATE_BYTES", 131072, 1, 1048576)?;
    let delay = number("CHURN_DELAY_MS", 0, 0, 1000)?;
    let dir = Temp::new();
    let mut server=Relay::production(executable(),json!({
"sessionDirectory":dir.0,"sessionMaxBytes":8388608,"maxConnections":count+16,"maxConnectionsPerIp":count+16,"maxConnectionsPerMinute":100000,"maxAccounts":count*2,"maxRooms":count,"maxMessagesPerSecond":10000,"accountTtlMs":300,"maintenanceIntervalMs":50,"sendDelayMs":delay,"verboseLogs":false}
)).await?;

    let baseline = resources::read(server.pid()).await?;
    let mut rounds = vec![];
    for cycle in 1..=cycles {
        let mut clients = vec![];
        for _ in 0..count {
            let c = Client::connect(&server.url).await?;
            c.heartbeats();
            clients.push(c);
        }
        for members in clients.chunks_mut(4) {
            let (host, peers) = members.split_first_mut().unwrap();
            let room = host.room(json!({"binaryRelay":true})).await?;
            for peer in peers.iter_mut() {
                peer.enter(&room).await?;
            }
            host.send(
                "startGame",
                json!({"fixedRoster":true,"hostMigration":true,"persistent":true}),
            )?;
            host.wait("gameStarted").await?;
            host.save(&vec![cycle as u8; size], 0, 0, json!({})).await?;
            let reply = host
                .reply(
                    "beginSession",
                    json!({"revision":1,"generation":0,"size":size*2}),
                )
                .await?;
            anyhow::ensure!(reply.get("error").is_none(), "Upload failed: {reply}");
            for c in members {
                c.send("sendToRoom", json!({"padding":"x".repeat(1024)}))?;
            }
        }
        let loaded = resources::read(server.pid()).await?;
        if cycle % 2 == 1 {
            for c in &clients {
                c.send("leaveRoom", Value::Null)?;
            }
            for c in &mut clients {
                c.barrier().await?;
            }
        }
        drop(clients);
        let health = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let health = server.health().await?;
                anyhow::ensure!(health["status"] == "ok", "Health failed");
                if ["accounts", "online", "rooms", "pendingConnections"]
                    .iter()
                    .all(|key| health[key] == 0)
                {
                    return Ok::<_, anyhow::Error>(health);
                }
                sleep(50).await;
            }
        })
        .await??;
        let idle = resources::read(server.pid()).await?;
        let row = json!({"cycle":cycle,"loaded":loaded,"idle":idle,"health":health});
        println!("{row}");
        rounds.push(row);
    }
    let result = json!({
    "timestamp":chrono::Utc::now(),"platform":std::env::consts::OS,"executable":executable(),"generator":"rust","cycles":cycles,"clientsPerCycle":count,"connectionsCreated":cycles*count,"stateBytesPerRoom":size,"partialUploadBytesPerRoom":size*2,"delayMs":delay,"accountTtlMs":300,"sessionDiskQuotaBytes":8388608,"methodology":"One production-mode process; persisted states, unfinished uploads, normal leave and abrupt close; live health counters must return to zero after TTL. Private bytes and RSS are sampled separately. Allocator high-water memory is not itself a leak; this check cannot prove absence of all leaks.","baseline":baseline,"rounds":rounds}
    );

    report(
        &std::env::var("CHURN_OUTPUT").unwrap_or("test-results/memory-churn/report.json".into()),
        &result,
    )?;
    server.stop().await
}
async fn pair_phase(
    mut a: Client,
    mut b: Client,
    size: usize,
    binary: bool,
    duration: Duration,
) -> Result<(Client, Client, u64, Vec<u64>)> {
    let deadline = Instant::now() + duration;
    let mut count = 0;
    let mut hist = vec![0u64; 100002];
    let frame = packet(None, &vec![0; size - 17]);
    let payload = json!({"padding":"x".repeat(size.saturating_sub(100))});
    while Instant::now() < deadline {
        let start = Instant::now();
        if binary {
            a.bytes(frame.clone())?;
            let incoming = b.binary().await?;
            b.bytes(incoming)?;
            let reply = a.binary().await?;
            anyhow::ensure!(reply[17..] == frame[17..], "Corrupt echo");
        } else {
            a.send("sendToRoom", payload.clone())?;
            let msg = b.wait("messageFromPlayer").await?;
            b.send("sendToRoom", msg["msg"].clone())?;
            anyhow::ensure!(
                a.wait("messageFromPlayer").await?["msg"] == payload,
                "Corrupt JSON echo"
            );
        }
        let micros = start.elapsed().as_micros() as usize;
        hist[(micros / 10).min(100001)] += 1;
        count += 1;
    }
    Ok((a, b, count, hist))
}
pub async fn benchmark() -> Result<()> {
    let duration = number("COMPARE_DURATION_MS", 5000, 1, 600000)?;
    let rounds = number("COMPARE_ROUNDS", 3, 1, 100)?;
    let pairs = number("COMPARE_PAIRS", 16, 1, 512)?;
    let protocol = std::env::var("COMPARE_PROTOCOL").unwrap_or("binary".into());
    anyhow::ensure!(
        ["binary", "json"].contains(&protocol.as_str()),
        "Expected binary or json protocol"
    );
    let sizes = std::env::var("COMPARE_SIZES")
        .unwrap_or("512,32000".into())
        .split(',')
        .map(str::parse::<usize>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    anyhow::ensure!(
        sizes.iter().all(|n| (25..=64000).contains(n)),
        "Sizes must be 25..64000"
    );
    let variants: Value = std::env::var("COMPARE_NATIVE_BINARIES")
        .ok()
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or(json!({"rust":executable()}));
    let variants = variants
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Expected name-to-binary mapping"))?;
    let mut results = vec![];
    for round in 1..=rounds {
        for size in &sizes {
            let mut order = variants.iter().collect::<Vec<_>>();
            if round % 2 == 0 {
                order.reverse();
            }
            for (name, path) in order {
                let mut server=Relay::production(PathBuf::from(path.as_str().ok_or_else(||anyhow::anyhow!("Binary path must be a string"))?),json!({
"maxConnections":1024,"maxConnectionsPerIp":1024,"maxConnectionsPerMinute":10000,"maxMessagesPerSecond":100000,"idleTimeoutMs":120000,"verboseLogs":false}
)).await?;

                let idle = resources::read(server.pid()).await?;
                let mut tasks = tokio::task::JoinSet::new();
                for _ in 0..pairs {
                    let mut a = Client::connect(&server.url).await?;
                    let mut b = Client::connect(&server.url).await?;
                    a.heartbeats();
                    b.heartbeats();
                    let room = a
                        .room(json!({"name":"Benchmark","maxPlayers":2,"binaryRelay":true}))
                        .await?;
                    b.enter(&room).await?;
                    tasks.spawn(pair_phase(
                        a,
                        b,
                        *size,
                        protocol == "binary",
                        Duration::from_secs(1),
                    ));
                }
                let mut ready = vec![];
                while let Some(result) = tasks.join_next().await {
                    let (a, b, _, _) = result??;
                    ready.push((a, b));
                }
                let before = resources::read(server.pid()).await?;
                let start = Instant::now();
                for (a, b) in ready {
                    tasks.spawn(pair_phase(
                        a,
                        b,
                        *size,
                        protocol == "binary",
                        Duration::from_millis(duration as u64),
                    ));
                }
                let mut count = 0u64;
                let mut hist = vec![0u64; 100002];
                let mut held = vec![];
                while let Some(result) = tasks.join_next().await {
                    let (a, b, n, h) = result??;
                    held.push((a, b));
                    count += n;
                    for (to, from) in hist.iter_mut().zip(h) {
                        *to += from;
                    }
                }
                let elapsed = start.elapsed().as_secs_f64() * 1000.;
                let after = resources::read(server.pid()).await?;
                anyhow::ensure!(count > 0, "No round trips completed");
                let pct = |q: f64| {
                    let target = (count as f64 * q).ceil() as u64;
                    let mut sum = 0;
                    for (i, n) in hist.iter().enumerate() {
                        sum += n;
                        if sum >= target {
                            return i as f64 / 100.;
                        }
                    }
                    0.
                };
                let cpu = after["cpuMs"].as_f64().unwrap() - before["cpuMs"].as_f64().unwrap();
                let row = json!({
                "backend":name,"round":round,"protocol":protocol,"bytes":size,"pairs":pairs,"clients":pairs*2,"elapsedMs":elapsed,"roundTrips":count,"roundTripsPerSecond":count as f64*1000./elapsed,"relayMessagesPerSecond":count as f64*2000./elapsed,"latencyMs":{
                "p50":pct(0.5),"p95":pct(0.95),"p99":pct(0.99)}
                ,"latencyOverflowSamples":hist[100001],"cpuMs":cpu,"cpuMsPer1000RoundTrips":cpu*1000./count as f64,"idleRssBytes":idle["rssBytes"],"rssBytes":after["rssBytes"],"peakRssBytes":after["peakRssBytes"],"threads":after["threads"]}
                );

                println!("{row}");
                results.push(row);
                drop(held);
                server.stop().await?;
            }
        }
    }
    report(
        &std::env::var("COMPARE_OUTPUT").unwrap_or("test-results/rust-comparison.json".into()),
        &json!({
        "timestamp":chrono::Utc::now(),"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"generator":"rust","methodology":"Separate server process; closed-loop paired relay echo; 1s warmup, alternating variant order. RTT histogram has 0.01ms bins up to 1000ms plus overflow. Generator changed from Node: remeasure both binaries with this generator for valid comparisons.","results":results}
        ),
    )
}
