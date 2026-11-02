// Shared integration/load-tool helpers; each executable uses a subset.
#![allow(dead_code)]
use anyhow::{Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{collections::VecDeque, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, mpsc},
    task::JoinHandle,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
pub const WAIT: Duration = Duration::from_secs(5);
pub async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}
pub struct Temp(pub PathBuf);
impl Temp {
    pub fn new() -> Self {
        let p = std::env::temp_dir().join(format!("rust-relay-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub fn binary() -> PathBuf {
    std::env::var_os("RUST_SERVER_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            option_env!("CARGO_BIN_EXE_no-logic-game-server")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::current_exe().unwrap().with_file_name(format!(
                        "no-logic-game-server{}",
                        std::env::consts::EXE_SUFFIX
                    ))
                })
        })
}
#[derive(Default)]
struct Observed {
    records: Vec<Value>,
    snapshot: Value,
    port: u16,
    sync: String,
}
pub struct Relay {
    child: Child,
    stdin: ChildStdin,
    observed: Arc<Mutex<Observed>>,
    readers: Vec<JoinHandle<()>>,
    pub url: String,
}
impl Relay {
    pub async fn start(options: Value) -> Result<Self> {
        Self::start_binary(binary(), options).await
    }
    pub async fn start_binary(executable: PathBuf, options: Value) -> Result<Self> {
        Self::spawn(executable, options, true).await
    }
    pub async fn production(executable: PathBuf, options: Value) -> Result<Self> {
        Self::spawn(executable, options, false).await
    }
    async fn spawn(executable: PathBuf, options: Value, test_control: bool) -> Result<Self> {
        let mut command = Command::new(executable);
        command.envs([
            ("HOST", "127.0.0.1"),
            ("PORT", "0"),
            ("SESSION_DIRECTORY", ""),
            ("FCM_ENABLED", "false"),
            ("TELEMETRY_ENABLED", "false"),
            ("RELAY_TEST_CONTROL", "1"),
            ("MAINTENANCE_INTERVAL_MS", "10"),
            ("SHUTDOWN_TIMEOUT_MS", "200"),
            ("IDLE_TIMEOUT_MS", "30000"),
            ("AUTH_TIMEOUT_MS", "1000"),
        ]);
        if let Some(options) = options.as_object() {
            for (key, v) in options {
                let env_key = key.chars().fold(String::new(), |mut s, c| {
                    if c.is_uppercase() {
                        s.push('_')
                    };
                    s.extend(c.to_uppercase());
                    s
                });
                let value = if let Some(s) = v.as_str() {
                    s.to_string()
                } else if let Some(a) = v.as_array() {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                } else {
                    v.to_string()
                };
                command.env(env_key, value);
            }
        }
        if !test_control {
            command.env_remove("RELAY_TEST_CONTROL");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let observed = Arc::new(Mutex::new(Observed::default()));
        let out = observed.clone();
        let a = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let mut s = out.lock().await;
                    if v["event"] == "server.listening" {
                        s.port = v["address"]["port"].as_u64().unwrap() as u16;
                    }
                    if v.get("stats").is_some() {
                        s.snapshot = v.clone();
                    }
                    if let Some(id) = v["sync"].as_str() {
                        s.sync = id.into();
                    }
                    if s.records.len() < 10000 && v.get("stats").is_none() {
                        s.records.push(v);
                    }
                }
            }
        });
        let err = observed.clone();
        let b = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                err.lock().await.records.push(json!({"stderr":line}));
            }
        });
        let mut relay = Self {
            child,
            stdin,
            observed,
            readers: vec![a, b],
            url: String::new(),
        };
        tokio::time::timeout(WAIT, async {
            loop {
                let port = relay.observed.lock().await.port;
                if port != 0 {
                    relay.url = format!("ws://127.0.0.1:{port}/");
                    return Ok(());
                }
                if let Some(exit) = relay.child.try_wait()? {
                    bail!("Relay exited {exit}: {:?}", relay.records().await);
                }
                sleep(5).await;
            }
        })
        .await??;
        Ok(relay)
    }
    pub async fn control(&mut self, mut value: Value) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        value["sync"] = json!(id);
        self.stdin
            .write_all(format!("{value}\n").as_bytes())
            .await?;
        tokio::time::timeout(WAIT, async {
            loop {
                if self.observed.lock().await.sync == id {
                    break;
                }
                sleep(2).await;
            }
        })
        .await?;
        Ok(())
    }
    pub async fn sync(&mut self) -> Result<Value> {
        self.control(json!({})).await?;
        Ok(self.observed.lock().await.snapshot.clone())
    }
    pub async fn records(&self) -> Vec<Value> {
        self.observed.lock().await.records.clone()
    }
    pub async fn stop(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            self.stdin.write_all(b"stop\n").await?;
            let status = tokio::time::timeout(WAIT, self.child.wait()).await??;
            assert!(status.success(), "{status}");
        }
        Ok(())
    }
    pub async fn kill(&mut self) -> Result<()> {
        self.child.kill().await?;
        Ok(())
    }
    pub async fn health(&self) -> Result<Value> {
        Ok(reqwest::Client::builder()
            .timeout(WAIT)
            .build()?
            .get(self.url.replace("ws:", "http:") + "healthz")
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }
    pub fn pid(&self) -> u32 {
        self.child.id().unwrap()
    }
}
impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        for t in &self.readers {
            t.abort();
        }
    }
}
pub struct Client {
    pub account: Value,
    tx: mpsc::Sender<Message>,
    rx: mpsc::Receiver<Message>,
    pending: VecDeque<Message>,
    task: JoinHandle<()>,
    pub close: Option<u16>,
    paused: tokio::sync::watch::Sender<bool>,
    heartbeat: Arc<std::sync::atomic::AtomicBool>,
    queued: Arc<std::sync::atomic::AtomicUsize>,
}
impl Client {
    pub async fn raw(url: &str, origin: Option<&str>) -> Result<Self> {
        let mut request = url.into_client_request()?;
        if let Some(origin) = origin {
            request.headers_mut().insert("Origin", origin.parse()?);
        }
        let (ws, _) = tokio::time::timeout(WAIT, connect_async(request)).await??;
        let (mut sink, mut stream) = ws.split();
        let (tx, mut outbound) = mpsc::channel::<Message>(256);
        let (incoming, rx) = mpsc::channel::<Message>(256);
        let (paused, mut pause) = tokio::sync::watch::channel(false);
        let heartbeat = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let beats = heartbeat.clone();
        let queued = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writer_queue = queued.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = outbound.recv() => {
                        let Some(msg) = msg else { break };
                        let bytes = msg.len();
                        let sent = sink.send(msg).await;
                        writer_queue.fetch_sub(bytes, std::sync::atomic::Ordering::Relaxed);
                        if sent.is_err() { break }
                    }
                    _ = pause.changed() => {}
                    msg = stream.next(), if !*pause.borrow() => {
                        let Some(Ok(message)) = msg else { break };
                        if beats.load(std::sync::atomic::Ordering::Relaxed)
                            && let Message::Text(text) = &message
                            && let Ok(value) = serde_json::from_str::<Value>(text)
                            && value["method"] == "Ping"
                        {
                            let pong = json!({"method":"Pong","data":value["data"]});
                            if sink.send(Message::Text(pong.to_string().into())).await.is_err() { break }
                            continue;
                        }
                        let closed = message.is_close();
                        if incoming.send(message).await.is_err() || closed { break }
                    }
                }
            }
        });
        Ok(Self {
            account: Value::Null,
            tx,
            rx,
            pending: VecDeque::new(),
            task,
            close: None,
            paused,
            heartbeat,
            queued,
        })
    }
    pub async fn connect(url: &str) -> Result<Self> {
        Self::auth(url, json!({})).await
    }
    pub async fn auth(url: &str, credentials: Value) -> Result<Self> {
        let mut c = Self::raw(url, None).await?;
        c.send("authenticate", credentials.clone())?;
        c.account = if credentials.get("playerId").is_some() {
            credentials
        } else {
            c.wait("accountCreated").await?
        };
        c.wait("onConnected").await?;
        Ok(c)
    }
    pub fn pause(&self, value: bool) {
        let _ = self.paused.send(value);
    }
    pub fn heartbeats(&self) {
        self.heartbeat
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn disconnect(&self) {
        self.task.abort();
    }
    pub async fn wait_where(
        &mut self,
        name: &str,
        predicate: impl Fn(&Value) -> bool,
    ) -> Result<Value> {
        loop {
            let v = self.wait(name).await?;
            if predicate(&v) {
                return Ok(v);
            }
        }
    }
    pub fn send(&self, method: &str, data: Value) -> Result<()> {
        self.frame(Message::Text(
            json!({"method":method,"data":data}).to_string().into(),
        ))
    }
    pub fn buffered_bytes(&self) -> usize {
        self.queued.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn frame(&self, frame: Message) -> Result<()> {
        let bytes = frame.len();
        let before = self
            .queued
            .fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
        if before.saturating_add(bytes) > 1024 * 1024 {
            self.queued
                .fetch_sub(bytes, std::sync::atomic::Ordering::Relaxed);
            bail!("Client send buffer exceeded 1 MiB");
        }
        if let Err(error) = self.tx.try_send(frame) {
            self.queued
                .fetch_sub(bytes, std::sync::atomic::Ordering::Relaxed);
            bail!("Socket writer unavailable: {error}");
        }
        Ok(())
    }
    pub fn bytes(&self, bytes: Vec<u8>) -> Result<()> {
        self.frame(Message::Binary(bytes.into()))
    }
    pub fn id(&self) -> &str {
        self.account["playerId"].as_str().unwrap()
    }
    fn matches(m: &Message, name: &str) -> bool {
        match m {
            Message::Binary(_) => name == "binary",
            Message::Ping(_) => name == "ping",
            Message::Pong(_) => name == "pong",
            Message::Close(_) => name == "close",
            Message::Text(s) => serde_json::from_str::<Value>(s)
                .ok()
                .is_some_and(|v| v["method"] == name),
            _ => false,
        }
    }
    pub async fn take(&mut self, name: &str) -> Result<Message> {
        if let Some(i) = self.pending.iter().position(|m| Self::matches(m, name)) {
            return Ok(self.pending.remove(i).unwrap());
        }
        tokio::time::timeout(WAIT, async {
            loop {
                let m = match self.rx.recv().await {
                    Some(m) => m,
                    None if name == "close" => return Ok(Message::Close(None)),
                    None => return Err(anyhow!("socket closed waiting for {name}")),
                };
                if Self::matches(&m, name) {
                    return Ok(m);
                }
                self.pending.push_back(m);
            }
        })
        .await
        .map_err(|_| anyhow!("timed out waiting for {name}, pending {:?}", self.pending))?
    }
    pub async fn wait(&mut self, name: &str) -> Result<Value> {
        let m = self.take(name).await?;
        Ok(serde_json::from_str::<Value>(m.to_text()?)?["data"].clone())
    }
    pub async fn next_frame(&mut self) -> Result<Message> {
        if let Some(m) = self.pending.pop_front() {
            return Ok(m);
        }
        self.rx.recv().await.ok_or_else(|| anyhow!("socket closed"))
    }
    pub async fn binary(&mut self) -> Result<Vec<u8>> {
        Ok(self.take("binary").await?.into_data().to_vec())
    }
    pub async fn none(&mut self, name: &str) -> Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(30);
        while let Ok(Some(m)) = tokio::time::timeout_at(deadline, self.rx.recv()).await {
            self.pending.push_back(m);
        }
        assert!(
            !self.pending.iter().any(|m| Self::matches(m, name)),
            "unexpected {name}"
        );
        Ok(())
    }
    pub async fn closed(&mut self) -> Result<u16> {
        match self.take("close").await? {
            Message::Close(Some(f)) => {
                let code = u16::from(f.code);
                self.close = Some(code);
                Ok(code)
            }
            _ => Ok(1005),
        }
    }
    pub async fn barrier(&mut self) -> Result<Value> {
        self.send("getPlayers", Value::Null)?;
        self.wait("onGetPlayers").await
    }
    pub async fn room(&mut self, mut options: Value) -> Result<Value> {
        if options.get("name").is_none() {
            options["name"] = json!("Test room")
        }
        if options.get("maxPlayers").is_none() {
            options["maxPlayers"] = json!(4)
        }
        self.send("createRoom", options)?;
        self.wait("onRoomEnter").await
    }
    pub async fn enter(&mut self, room: &Value) -> Result<Value> {
        self.send("enterRoom", json!({"roomId":room["roomId"]}))?;
        self.wait("onRoomEnter").await
    }
    pub async fn error(&mut self, method: &str, data: Value, code: &str) -> Result<()> {
        self.send(method, data)?;
        assert_eq!(self.wait("error").await?["code"], code);
        Ok(())
    }
    pub async fn reply(&mut self, method: &str, mut data: Value) -> Result<Value> {
        if data.get("requestId").is_none() {
            data["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        }
        let id = data["requestId"].clone();
        self.send(method, data)?;
        loop {
            let v = self.wait("sessionReply").await?;
            if v["requestId"] == id {
                return Ok(v);
            }
        }
    }
    pub async fn save(
        &mut self,
        bytes: &[u8],
        revision: u64,
        generation: u64,
        notices: Value,
    ) -> Result<()> {
        let id = uuid::Uuid::new_v4();
        let v=self.reply("beginSession",json!({"requestId":id.to_string(),"size":bytes.len(),"revision":revision,"generation":generation})).await?;
        assert_eq!(v["offset"], 0);
        for (offset, chunk) in bytes.chunks(32000).enumerate() {
            let offset = offset * 32000;
            let mut b = vec![2];
            b.extend(id.as_bytes());
            b.extend((offset as u32).to_be_bytes());
            b.extend(chunk);
            self.bytes(b)?;
            assert_eq!(
                self.wait("sessionReply").await?["offset"],
                offset + chunk.len()
            );
        }
        let v=self.reply("commitSession",json!({"requestId":id.to_string(),"scheduled":notices["scheduled"],"immediate":notices["immediate"]})).await?;
        assert_eq!(v["revision"], revision + 1);
        Ok(())
    }
    pub async fn load(&mut self) -> Result<(Value, Vec<u8>)> {
        let info = self.reply("getSession", json!({})).await?;
        let mut bytes = vec![];
        while bytes.len() < info["size"].as_u64().unwrap() as usize {
            self.send("getSessionChunk",json!({"requestId":uuid::Uuid::new_v4().to_string(),"revision":info["revision"],"offset":bytes.len()}))?;
            let b = self.binary().await?;
            assert_eq!(b[0], 3);
            assert_eq!(
                u32::from_be_bytes(b[17..21].try_into().unwrap()) as usize,
                bytes.len()
            );
            bytes.extend(&b[21..]);
        }
        Ok((info, bytes))
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub fn packet(target: Option<&str>, payload: &[u8]) -> Vec<u8> {
    let mut b = vec![1];
    b.extend(
        target
            .map(|id| *uuid::Uuid::parse_str(id).unwrap().as_bytes())
            .unwrap_or([0; 16]),
    );
    b.extend(payload);
    b
}
impl Relay {
    pub async fn wait_snapshot(&mut self, predicate: impl Fn(&Value) -> bool) -> Result<Value> {
        tokio::time::timeout(WAIT, async {
            loop {
                let v = self.sync().await?;
                if predicate(&v) {
                    return Ok(v);
                }
                sleep(10).await;
            }
        })
        .await?
    }
}
pub struct MockPush {
    pub url: String,
    records: Arc<Mutex<Vec<Value>>>,
    task: JoinHandle<()>,
}
impl MockPush {
    pub async fn start(
        handler: impl Fn(&Value, usize) -> (u16, Value) + Send + Sync + 'static,
    ) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let records = Arc::new(Mutex::new(vec![]));
        let captured = records.clone();
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((mut tcp, _)) = accepted else { break };
                        let captured = captured.clone();
                        let handler = handler.clone();
                        connections.spawn(tokio::time::timeout(WAIT, async move {
                            use tokio::io::AsyncReadExt;
                            let mut data = Vec::new();
                            let mut chunk = [0; 4096];
                            let end = loop {
                                let n = tcp.read(&mut chunk).await?;
                                if n == 0 { bail!("early EOF") }
                                data.extend(&chunk[..n]);
                                if let Some(p) = data.windows(4).position(|v|v==b"\r\n\r\n") { break p+4 }
                                if data.len()>16384 { bail!("header limit") }
                            };
                            let length = String::from_utf8_lossy(&data[..end]).lines().find_map(|l| {
                                l.to_ascii_lowercase().strip_prefix("content-length:")
                                    .and_then(|n|n.trim().parse::<usize>().ok())
                            }).unwrap_or(0);
                            if length>65536 { bail!("body limit") }
                            while data.len()<end+length {
                                let n = tcp.read(&mut chunk).await?;
                                if n==0 { bail!("early body EOF") }
                                data.extend(&chunk[..n]);
                            }
                            let value: Value = serde_json::from_slice(&data[end..end+length])?;
                            let mut records = captured.lock().await;
                            records.push(value.clone());
                            let (status, body) = handler(&value, records.len());
                            drop(records);
                            let body = body.to_string();
                            tcp.write_all(format!(
                                "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()
                            ).as_bytes()).await?;
                            Ok::<(), anyhow::Error>(())
                        }));
                    }
                }
            }
        });
        Ok(Self { url, records, task })
    }
    pub async fn records(&self) -> Vec<Value> {
        self.records.lock().await.clone()
    }
    pub async fn wait(&self, count: usize) -> Result<Vec<Value>> {
        tokio::time::timeout(WAIT, async {
            loop {
                let v = self.records().await;
                if v.len() >= count {
                    return v;
                }
                sleep(5).await;
            }
        })
        .await
        .map_err(Into::into)
    }
}
impl Drop for MockPush {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub async fn game(options: Value) -> Result<(Relay, Client, Client, Value)> {
    let server = Relay::start(options).await?;
    let mut host = Client::connect(&server.url).await?;
    let mut guest = Client::connect(&server.url).await?;
    let room = host.room(json!({"binaryRelay":true})).await?;
    guest.enter(&room).await?;
    host.send("startGame",json!({"fixedRoster":true,"hostMigration":true,"persistent":true,"example":"opaque bootstrap"}))?;
    host.wait("gameStarted").await?;
    guest.wait("gameStarted").await?;
    Ok((server, host, guest, room))
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
pub fn chunk(id: uuid::Uuid, offset: u32, bytes: &[u8]) -> Vec<u8> {
    let mut b = vec![2];
    b.extend(id.as_bytes());
    b.extend(offset.to_be_bytes());
    b.extend(bytes);
    b
}
pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
