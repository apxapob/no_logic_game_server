use super::*;
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;
#[derive(Clone)]
struct Phase {
    epoch: u64,
    clients: usize,
    start: Instant,
    stop: Instant,
    stats: Arc<Mutex<Stats>>,
}
struct Stats {
    sent: u64,
    sent_bytes: u64,
    expected: u64,
    received: u64,
    received_bytes: u64,
    duplicates: u64,
    missed: u64,
    max_buffered: usize,
    latencies: Vec<u64>,
    total_ms: f64,
    max_ms: f64,
    errors: u64,
    disconnects: u64,
}
impl Default for Stats {
    fn default() -> Self {
        Self {
            sent: 0,
            sent_bytes: 0,
            expected: 0,
            received: 0,
            received_bytes: 0,
            duplicates: 0,
            missed: 0,
            max_buffered: 0,
            latencies: vec![0; 10002],
            total_ms: 0.,
            max_ms: 0.,
            errors: 0,
            disconnects: 0,
        }
    }
}
impl Stats {
    fn latency(&mut self, value: f64) {
        self.latencies[(value.max(0.) as usize).min(10001)] += 1;
        self.total_ms += value;
        self.max_ms = self.max_ms.max(value);
    }
    fn percentile(&self, p: f64) -> Option<usize> {
        if self.received == 0 {
            return None;
        }
        let target = (self.received as f64 * p).ceil() as u64;
        let mut count = 0;
        for (i, n) in self.latencies.iter().enumerate() {
            count += n;
            if count >= target {
                return Some(i);
            }
        }
        None
    }
}
fn emit(file: &mut std::fs::File, row: Value) -> Result<()> {
    writeln!(file, "{row}")?;
    println!("{row}");
    Ok(())
}
fn numeric(cfg: &Value, key: &str, default: u64, min: u64, max: u64) -> Result<u64> {
    let n = match cfg.get(key) {
        None => default,
        Some(v) => v
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("{key} must be an integer"))?,
    };
    anyhow::ensure!((min..=max).contains(&n), "Invalid {key}");
    Ok(n)
}
struct Worker {
    client: Client,
    index: usize,
    owner: String,
    is_owner: bool,
    room_size: usize,
    hz: u64,
    padding: String,
    run: String,
}
async fn worker(
    mut w: Worker,
    mut phases: watch::Receiver<Option<Phase>>,
    fatal: Arc<Mutex<Option<String>>>,
) -> Result<()> {
    let period = Duration::from_secs_f64(1. / w.hz as f64);
    let mut current: Option<Phase> = None;
    let mut next = Instant::now();
    let mut sequence = 0u64;
    let mut seen = std::collections::HashMap::new();
    loop {
        tokio::select! {
            changed = phases.changed() => {
                if changed.is_err() { return Ok(()) }
                current = phases.borrow().clone();
                seen.clear();
                if let Some(p) = &current {
                    next = p.start + period.mul_f64(w.index as f64 / p.clients as f64);
                }
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(next)),
                if current.as_ref().is_some_and(|p| next < p.stop) => {
                let p = current.as_ref().unwrap();
                let time = Instant::now();
                if time >= p.stop { next = p.stop; continue }
                let missed = (time.saturating_duration_since(next).as_secs_f64()
                    / period.as_secs_f64()).floor() as u64;
                next += period.mul_f64((missed + 1) as f64);
                let payload = json!({
                    "lt":w.run, "e":p.epoch, "s":w.index, "q":sequence,
                    "t":time.duration_since(p.start).as_secs_f64()*1000., "pad":w.padding
                });
                sequence += 1;
                let (method, data) = if w.is_owner {
                    ("shareGameState", json!({"gamestate":payload}))
                } else {
                    ("sendTo", json!({"to":[w.owner],"msg":payload}))
                };
                let size = json!({"method":method,"data":data}).to_string().len();
                let buffered = w.client.buffered_bytes();
                w.client.send(method, data)?;
                let mut stats = p.stats.lock().unwrap();
                stats.sent += 1;
                stats.sent_bytes += size as u64;
                stats.expected += if w.is_owner { w.room_size as u64 - 1 } else { 1 };
                stats.missed += missed;
                stats.max_buffered = stats.max_buffered.max(buffered);
            }
            incoming = w.client.next_frame() => {
                let frame = match incoming {
                    Ok(frame) if !frame.is_close() => frame,
                    _ => {
                        if let Some(p) = &current { p.stats.lock().unwrap().disconnects += 1; }
                        bail!("Client {} disconnected", w.index);
                    }
                };
                if let Message::Text(text) = frame {
                    let value: Value = serde_json::from_str(&text)?;
                    if value["method"] == "error" || value["method"] == "wrongPassword" {
                        if let Some(p) = &current { p.stats.lock().unwrap().errors += 1; }
                        bail!("Server rejected client {}: {}", w.index, value["data"]["code"]);
                    }
                    let data = if value["method"] == "newGameState" {
                        &value["data"]
                    } else { &value["data"]["msg"] };
                    if let Some(p) = &current && data["lt"] == w.run && data["e"] == p.epoch {
                        let sender = data["s"].as_u64().ok_or_else(|| anyhow::anyhow!("Missing sender"))?;
                        let seq = data["q"].as_u64().ok_or_else(|| anyhow::anyhow!("Missing sequence"))?;
                        let time = data["t"].as_f64().ok_or_else(|| anyhow::anyhow!("Missing timestamp"))?;
                        let latency = Instant::now().duration_since(p.start).as_secs_f64()*1000. - time;
                        let mut stats = p.stats.lock().unwrap();
                        if seen.insert(sender,seq).is_some_and(|old|seq<=old) { stats.duplicates += 1; }
                        stats.received += 1;
                        stats.received_bytes += text.len() as u64;
                        stats.latency(latency);
                    }
                } else if frame.is_binary() { bail!("Unexpected binary response") }
            }
        }
        if fatal.lock().unwrap().is_some() {
            return Ok(());
        }
    }
}

async fn stage(
    cfg: &Value,
    spec: (usize, u64, u64, bool),
    tx: &watch::Sender<Option<Phase>>,
    fatal: &Arc<Mutex<Option<String>>>,
    file: &mut std::fs::File,
) -> Result<Value> {
    let (count, seconds, epoch, measured) = spec;
    let stats = Arc::new(Mutex::new(Stats::default()));
    let before = resources::read(std::process::id()).await?;
    let start = Instant::now();
    let start_time = chrono::Utc::now();
    let stop = start + Duration::from_secs(seconds);
    tx.send(Some(Phase {
        epoch,
        clients: count,
        start,
        stop,
        stats: stats.clone(),
    }))?;
    while Instant::now() < stop && fatal.lock().unwrap().is_none() {
        sleep(50).await;
    }
    let elapsed = start
        .elapsed()
        .min(Duration::from_secs(seconds))
        .as_secs_f64();
    let stop_time = chrono::Utc::now();
    let after = resources::read(std::process::id()).await?;
    let drain = Instant::now() + Duration::from_secs(5);
    loop {
        let done = {
            let s = stats.lock().unwrap();
            s.received >= s.expected
        };
        if done || Instant::now() > drain || fatal.lock().unwrap().is_some() {
            break;
        }
        sleep(20).await;
    }
    tx.send(None)?;
    let s = stats.lock().unwrap();
    let cpu = after["cpuMs"].as_f64().unwrap() - before["cpuMs"].as_f64().unwrap();
    let hz = cfg["hz"].as_u64().unwrap();
    let failure = fatal.lock().unwrap().clone();
    let row = json!({
        "event": if measured { "stage" } else { "warmup" },
        "run":cfg["run"], "epoch":epoch, "profile":cfg["profile"], "clients":count,
        "rooms":count/cfg["roomSize"].as_u64().unwrap() as usize, "roomSize":cfg["roomSize"],
        "hzPerClient":hz, "stateTargetBytes":cfg["stateBytes"], "inputTargetBytes":cfg["inputBytes"],
        "startTime":start_time, "stopTime":stop_time, "durationSeconds":elapsed,
        "sent":s.sent, "expectedDeliveries":s.expected, "received":s.received,
        "deliveryPercent":100.*s.received as f64/s.expected.max(1) as f64,
        "offeredRatePercent":100.*s.sent as f64/(count as f64*hz as f64*elapsed),
        "sendMessagesPerSecond":s.sent as f64/elapsed,
        "receiveMessagesPerSecond":s.received as f64/elapsed,
        "sendMbps":s.sent_bytes as f64*8./elapsed/1e6,
        "receiveMbps":s.received_bytes as f64*8./elapsed/1e6,
        "relayLatencyMs":{
            "samples":s.received, "p50":s.percentile(0.5), "p95":s.percentile(0.95),
            "p99":s.percentile(0.99), "max":s.max_ms,
            "mean": if s.received>0 { Some(s.total_ms/s.received as f64) } else { None }
        },
        "errors":s.errors, "disconnects":s.disconnects, "duplicates":s.duplicates,
        "generator":{
            "runtime":"rust", "cpuOneCorePercent":cpu/elapsed/10., "eventLoopP99Ms":Value::Null,
            "missedTicks":s.missed, "maxBufferedBytes":s.max_buffered, "queueCapacityFrames":256,
            "rssMiB":after["rssBytes"].as_f64().unwrap()/1048576.
        },
        "failure":failure
    });
    emit(file, row.clone())?;
    Ok(row)
}
pub async fn run(path: &str) -> Result<()> {
    let mut cfg: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let url = cfg["url"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing url"))?
        .to_string();
    anyhow::ensure!(
        url.starts_with("ws://") || url.starts_with("wss://"),
        "Invalid WebSocket URL"
    );
    let room_size = numeric(&cfg, "roomSize", 4, 2, 64)? as usize;
    let hz = numeric(&cfg, "hz", 20, 1, 1000)?;
    let state = numeric(&cfg, "stateBytes", 1000, 100, 60000)?;
    let input = numeric(&cfg, "inputBytes", 100, 100, 60000)?;
    let warmup = numeric(&cfg, "warmupSeconds", 5, 1, 3600)?;
    let duration = numeric(&cfg, "durationSeconds", 60, 1, 86400)?;
    let pause = numeric(&cfg, "rampPauseMs", 200, 0, 60000)?;
    let levels = cfg["levels"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing levels"))?
        .iter()
        .map(|v| {
            v.as_u64()
                .map(|n| n as usize)
                .ok_or_else(|| anyhow::anyhow!("Invalid client level"))
        })
        .collect::<Result<Vec<_>>>()?;
    anyhow::ensure!(
        !levels.is_empty()
            && levels
                .iter()
                .all(|n| *n > 0 && *n <= 100000 && n.is_multiple_of(room_size))
            && levels.windows(2).all(|n| n[0] < n[1]),
        "Levels must increase and be divisible by roomSize"
    );
    cfg["roomSize"] = json!(room_size);
    cfg["hz"] = json!(hz);
    cfg["stateBytes"] = json!(state);
    cfg["inputBytes"] = json!(input);
    let run = uuid()[..8].to_string();
    cfg["run"] = json!(run);
    let output = PathBuf::from(
        cfg["output"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing output"))?,
    );
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output)?;
    emit(
        &mut file,
        json!({"event":"start","run":run,"config":cfg,"generator":"rust","time":chrono::Utc::now()}),
    )?;
    let (tx, _rx) = watch::channel(None);
    let fatal = Arc::new(Mutex::new(None));
    let mut tasks = tokio::task::JoinSet::new();
    let mut count = 0;
    let mut epoch = 0;
    let mut stages = 0;
    let ramp_rooms = numeric(&cfg, "rampRooms", 4, 1, 1000)? as usize;
    let retry_limit = numeric(&cfg, "rampRetryLimit", 0, 0, 100)?;
    let mut retries = 0;
    let workload = async {
        for level in levels {
            let ramp_start = Instant::now();
            while count < level {
                let batch = ramp_rooms.min((level - count) / room_size);
                let mut pending = tokio::task::JoinSet::new();
                for offset in 0..batch {
                    let url = url.clone();
                    let run = run.clone();
                    let index = count + offset * room_size;
                    pending.spawn(async move {
                        for attempt in 0..=retry_limit {
                            match room(&url, &run, index, room_size).await {
                                Ok(members) => {
                                    return Ok::<_, anyhow::Error>((index, members, attempt));
                                }
                                Err(error) if attempt == retry_limit => return Err(error),
                                Err(_) => sleep(1000).await,
                            }
                        }
                        unreachable!()
                    });
                }
                while let Some(created) = pending.join_next().await {
                    let (index, members, attempts) = created??;
                    retries += attempts;
                    let owner = members[0].id().to_string();
                    for (i, client) in members.into_iter().enumerate() {
                        let w = Worker {
                            client,
                            index: index + i,
                            owner: owner.clone(),
                            is_owner: i == 0,
                            room_size,
                            hz,
                            padding: if i == 0 {
                                "x".repeat(state as usize - 100)
                            } else {
                                "y".repeat(input as usize - 100)
                            },
                            run: run.clone(),
                        };
                        let rx = tx.subscribe();
                        let failed = fatal.clone();
                        tasks.spawn(async move {
                            if let Err(error) = worker(w, rx, failed.clone()).await {
                                failed.lock().unwrap().get_or_insert(error.to_string());
                            }
                        });
                    }
                    count += room_size;
                }
                sleep(pause).await;
                if let Some(error) = fatal.lock().unwrap().as_ref() {
                    bail!("{error}");
                }
            }
            emit(
                &mut file,
                json!({
                    "event": "ramp", "run": run, "clients": count,
                    "rooms": count / room_size, "retries": retries,
                    "seconds": ramp_start.elapsed().as_secs_f64(), "time": chrono::Utc::now()
                }),
            )?;
            epoch += 1;
            stage(&cfg, (count, warmup, epoch, false), &tx, &fatal, &mut file).await?;
            epoch += 1;
            let row = stage(&cfg, (count, duration, epoch, true), &tx, &fatal, &mut file).await?;
            stages += 1;
            if fatal.lock().unwrap().is_some()
                || row["deliveryPercent"].as_f64().unwrap() < 99.9
                || row["offeredRatePercent"].as_f64().unwrap() < 95.
                || row["relayLatencyMs"]["p95"]
                    .as_f64()
                    .unwrap_or(f64::INFINITY)
                    > cfg["stopP95Ms"].as_f64().unwrap_or(500.)
                || row["duplicates"] != 0
            {
                bail!("Quality threshold exceeded at {count} clients");
            }
            sleep(1000).await;
        }
        Ok(())
    };
    let result: Result<()> = tokio::select! {
        outcome = workload => outcome,
        _ = tokio::signal::ctrl_c() => Err(anyhow::anyhow!("Interrupted")),
    };

    drop(tx);
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    emit(
        &mut file,
        json!({"event":"complete","run":run,"testedClients":count,"stages":stages,"failure":result.as_ref().err().map(ToString::to_string),"time":chrono::Utc::now()}),
    )?;
    result
}
async fn room(url: &str, run: &str, index: usize, size: usize) -> Result<Vec<Client>> {
    let mut clients = Vec::new();
    for _ in 0..size {
        clients.push(connect(url, None).await?);
    }
    let dto = clients[0]
        .room(json!({"name":format!("load-{run}-{index}"),"maxPlayers":size}))
        .await?;
    for client in clients.iter_mut().skip(1) {
        client.enter(&dto).await?;
    }
    clients[0].send("startGame", json!({"loadtest":run}))?;
    for client in &mut clients {
        client.wait("gameStarted").await?;
    }
    Ok(clients)
}
