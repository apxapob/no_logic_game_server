mod admission;
mod config;
mod diagnostics;
mod model;
mod protocol;
mod push;
mod server;
mod state;
mod store;
mod telemetry;
use admission::{Admission, Permit};
use anyhow::Result;
use config::Config;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use server::Server;
use state::Shared;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{Request, Response},
        protocol::WebSocketConfig,
    },
};
struct Prefixed {
    tcp: TcpStream,
    prefix: std::io::Cursor<Vec<u8>>,
}
impl tokio::io::AsyncRead for Prefixed {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let at = self.prefix.position() as usize;
        let data = self.prefix.get_ref();
        if at < data.len() {
            let n = buf.remaining().min(data.len() - at);
            buf.put_slice(&data[at..at + n]);
            self.prefix.set_position((at + n) as u64);
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.tcp).poll_read(cx, buf)
    }
}
impl tokio::io::AsyncWrite for Prefixed {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        b: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.tcp).poll_write(cx, b)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.tcp).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.tcp).poll_shutdown(cx)
    }
}
static TEST_CONTROL: std::sync::LazyLock<bool> =
    std::sync::LazyLock::new(|| std::env::var_os("RELAY_TEST_CONTROL").is_some());
static LISTENING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn snapshot(s: &Server) {
    if *TEST_CONTROL {
        use base64::Engine;
        println!(
            "{}",
            json!({"stats":s.stats(),"rooms":s.rooms.iter().map(|(id,r)|json!([id,{"active":r.active,"sessionState":base64::engine::general_purpose::STANDARD.encode(&r.state),"upload":r.upload.as_ref().map(|u|json!({"at":u.at}))}])).collect::<Vec<_>>(),"jobs":s.store.jobs})
        );
    }
}
async fn apply(s: Shared, f: impl FnOnce(&mut Server) + Send + 'static) {
    s.apply(f).await;
}
async fn finish_task(mut task: tokio::task::JoinHandle<()>, grace: Duration) {
    if tokio::time::timeout(grace, &mut task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}
#[allow(clippy::result_large_err)] // tungstenite's handshake callback fixes this error type.
async fn connection(
    mut tcp: TcpStream,
    cid: u64,
    s: Shared,
    cfg: Config,
    mut shutdown: watch::Receiver<bool>,
    _permit: Permit,
) -> Result<()> {
    tcp.set_nodelay(true)?;
    let deadline = Duration::from_millis(cfg.n("authTimeoutMs") as u64);
    let mut prefix = Vec::new();
    tokio::time::timeout(deadline, async {
        loop {
            let mut b = [0u8; 4096];
            let n = tcp.read(&mut b).await?;
            if n == 0 {
                return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
            }
            prefix.extend_from_slice(&b[..n]);
            if prefix.windows(4).any(|w| w == b"\r\n\r\n") {
                return Ok(());
            }
            if prefix.len() >= 16384 {
                return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
            }
        }
    })
    .await??;
    let header = String::from_utf8_lossy(&prefix).into_owned();
    let upgrade = header.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(key, value)| {
            key.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
        })
    });
    if !upgrade {
        let first = header.lines().next().unwrap_or("");
        let ok = first == "GET /healthz HTTP/1.1" || first == "GET /healthz HTTP/1.0";
        let body = if ok {
            let mut v = s.query(|s| s.stats()).await?;
            v["status"] = json!("ok");
            v.to_string()
        } else {
            String::new()
        };
        let response = format!(
            "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            if ok { "200 OK" } else { "404 Not Found" },
            body.len(),
            body
        );
        tcp.write_all(response.as_bytes()).await?;
        return Ok(());
    }
    let diagnostics = s.diagnostics.clone();
    let origins = cfg.0["allowedOrigins"].clone();
    let allow = cfg.b("allowNoOrigin");
    let mut config = WebSocketConfig::default();
    // The default 128 KiB scratch buffer is expensive with thousands of peers.
    // This is independent of frame/message limits; larger frames still work.
    config.read_buffer_size = 16 * 1024;
    config.max_message_size = Some(cfg.n("maxPayloadBytes"));
    config.max_frame_size = Some(cfg.n("maxPayloadBytes"));
    config.write_buffer_size = 0;
    let ws = tokio::time::timeout(
        deadline,
        accept_hdr_async_with_config(
            Prefixed {
                tcp,
                prefix: std::io::Cursor::new(prefix),
            },
            move |req: &Request, response: Response| {
                let permitted = req
                    .headers()
                    .get("origin")
                    .map(|h| {
                        h.to_str()
                            .ok()
                            .is_some_and(|s| origins.as_array().unwrap().contains(&json!(s)))
                    })
                    .unwrap_or(allow);
                if req.uri() != "/" || !permitted {
                    diagnostics.event("upgrade.rejected",json!({"reason":if req.uri()!="/"{"invalid_path"}else{"origin_not_allowed"}}));
                    return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(403)
                        .body(None)
                        .unwrap());
                }
                Ok(response)
            },
            Some(config),
        ),
    )
    .await??;
    let mut ws = ws;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let q = queued.clone();
    let (abort, mut aborted) = watch::channel(false);
    apply(s.clone(), move |s| s.connected(cid, tx, q, abort)).await;
    loop {
        tokio::select! {
            biased;
            _=aborted.changed()=>break,
            _=shutdown.changed()=>{
                use tokio_tungstenite::tungstenite::protocol::{CloseFrame,frame::coding::CloseCode};
                let _=tokio::time::timeout(Duration::from_millis(cfg.n("shutdownTimeoutMs") as u64),ws.close(Some(CloseFrame{code:CloseCode::Away,reason:"Server shutting down".into()}))).await;
                break;
            },
            msg=rx.recv()=>{
                let Some(msg)=msg else{break};
                let n=msg.len()+if msg.is_ping()||msg.is_pong(){2}else{10};
                let close=msg.is_close();
                let result=tokio::select!{
                    _=aborted.changed()=>break,
                    _=shutdown.changed()=>break,
                    result=tokio::time::timeout(Duration::from_millis(cfg.n("idleTimeoutMs") as u64),ws.send(msg))=>result
                };
                queued.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|v|Some(v.saturating_sub(n))).ok();
                if !matches!(result,Ok(Ok(()))){break}
                if close {
                    apply(s.clone(),move|s|s.disconnect(cid)).await;
                    // Drain peer data after sending Close. Dropping a Windows
                    // TCP socket with unread data can reset it and discard pongs
                    // already written before a rate-limit close.
                    let tcp=&mut ws.get_mut().tcp;
                    let _=tcp.shutdown().await;
                    let _=tokio::time::timeout(Duration::from_millis(cfg.n("shutdownTimeoutMs") as u64),async {
                        let mut discard=[0u8;4096];
                        while let Ok(n)=tcp.read(&mut discard).await {if n==0{break}}
                    }).await;
                    break;
                }
            },
            incoming=ws.next()=>{
                let Some(Ok(msg))=incoming else{break};
                if msg.is_close(){
                    tokio::select! {
                        _=aborted.changed()=>{},
                        _=shutdown.changed()=>{},
                        _=tokio::time::timeout(Duration::from_millis(cfg.n("shutdownTimeoutMs") as u64),ws.flush())=>{}
                    }
                    break
                }
                if msg.is_ping()||msg.is_pong(){
                    // Do not poll tungstenite again until our quota check and
                    // manual control reply have replaced its automatic pong.
                    let(done,finished)=tokio::sync::oneshot::channel();
                    apply(s.clone(),move|s|{s.receive(cid,msg);let _=done.send(());}).await;
                    let _=finished.await;
                }else{apply(s.clone(),move|s|s.receive(cid,msg)).await;}
            }
        }
    }
    apply(s, move |s| s.disconnect(cid)).await;
    Ok(())
}
async fn run() -> Result<()> {
    let cfg = Config::load()?;
    let telemetry = telemetry::Telemetry::new()?;
    let server = Server::new(cfg.clone())?;
    let notice_wake = server.notice_wake.clone();
    let legacy_wake = server.legacy_wake.clone();
    let push_sender = if server.push {
        Some(Arc::new(push::Sender::new().await?))
    } else {
        None
    };
    let s = Shared::new(server);
    let listener = TcpListener::bind((cfg.s("host"), cfg.n("port") as u16)).await?;
    let address = listener.local_addr()?;
    LISTENING.store(true, Ordering::Relaxed);
    let diagnostics = s.diagnostics.clone();
    diagnostics.event("server started", json!({}));
    diagnostics.event(
        "server.listening",
        json!({"address":{"address":address.ip().to_string(),"port":address.port()}}),
    );
    if *TEST_CONTROL || !cfg.b("verboseLogs") {
        println!(
            "{}",
            json!({"event":"server.listening","address":{"address":address.ip().to_string(),"port":address.port()}})
        );
    }
    let (stop, mut stopped) = watch::channel(false);
    let admission = Arc::new(Mutex::new(Admission::default()));
    let ss = s.clone();
    let interval = cfg.n("maintenanceIntervalMs");
    let mut sweep_stop = stopped.clone();
    let sweep = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(interval as u64));
        loop {
            tokio::select! {_=tick.tick()=>{apply(ss.clone(),Server::sweep).await;},_=sweep_stop.changed()=>break}
        }
    });
    let telemetry_s = s.clone();
    let mut telemetry_stop = stopped.clone();
    let telemetry_task = tokio::spawn(async move {
        if let Some(mut t) = telemetry {
            t.enqueue("server.started", json!({}));
            let mut tick = tokio::time::interval(Duration::from_millis(t.interval));
            loop {
                tokio::select! {_=tick.tick()=>t.sample(telemetry_s.clone()).await,_=telemetry_stop.changed()=>break}
            }
            t.close().await;
        }
    });
    let legacy_s = s.clone();
    let mut legacy_stop = stopped.clone();
    let legacy_sender = push_sender.clone();
    let legacy_task = tokio::spawn(async move {
        if let Some(sender) = legacy_sender {
            loop {
                tokio::select! {_=legacy_stop.changed()=>break,_=legacy_wake.notified()=>sender.deliver_legacy(legacy_s.clone()).await}
            }
        }
    });
    let push_s = s.clone();
    let mut push_stop = stopped.clone();
    let push_task = tokio::spawn(async move {
        if let Some(sender) = push_sender {
            loop {
                tokio::select! {_=push_stop.changed()=>break,_=tokio::time::sleep(Duration::from_millis(interval as u64))=>{},_=notice_wake.notified()=>{}}
                sender.deliver(push_s.clone()).await;
            }
        }
    });
    let stdin_s = s.clone();
    let stdin_stop = stop.clone();
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line == "stop" {
                let _ = stdin_stop.send(true);
                break;
            }
            if std::env::var_os("RELAY_TEST_CONTROL").is_some()
                && let Ok(v) = serde_json::from_str::<Value>(&line)
            {
                let s = stdin_s.clone();
                apply(s, move |s| {
                    if let Some(id) = v["uploadAt"]["id"].as_str()
                        && let Some(u) = s.rooms.get_mut(id).and_then(|r| r.upload.as_mut())
                    {
                        u.at = v["uploadAt"]["at"].as_u64().unwrap_or(0)
                    }
                    if let Some(id) = v["jobRetry"]["id"].as_str()
                        && let Some(j) = s.store.jobs.get_mut(id).and_then(|a| {
                            a.get_mut(v["jobRetry"]["index"].as_u64().unwrap_or(0) as usize)
                        })
                    {
                        j["retryAt"] = v["jobRetry"]["at"].clone()
                    }
                    if let Some(options) = v["options"].as_object() {
                        for (k, v) in options {
                            s.config.0[k] = v.clone()
                        }
                    }
                    if v.get("sync").is_some() {
                        snapshot(s);
                        println!("{}", json!({"sync":v["sync"]}));
                    }
                })
                .await;
            }
        }
    });
    let signal_stop = stop.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        let _ = signal_stop.send(true);
    });
    let mut tasks = tokio::task::JoinSet::new();
    let mut cid = 0u64;
    loop {
        tokio::select! {
            _ = stopped.changed() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (tcp, addr) = accepted?;
                if let Some(permit) = Admission::acquire(&admission, addr.ip().to_string(), &cfg) {
                    cid += 1;
                    tasks.spawn(connection(tcp, cid, s.clone(), cfg.clone(), stopped.clone(), permit));
                }
            }
        }
    }
    drop(listener);
    let _ = sweep.await;
    // Let an acknowledged push persist its delivery receipt before shutdown.
    // Slow providers/collectors still cannot hold the process indefinitely.
    let grace = Duration::from_millis(cfg.n("shutdownTimeoutMs") as u64);
    tokio::join!(
        finish_task(push_task, grace),
        finish_task(legacy_task, grace),
        finish_task(telemetry_task, grace),
    );
    let _ = tokio::time::timeout(
        Duration::from_millis(cfg.n("shutdownTimeoutMs") as u64),
        async { while tasks.join_next().await.is_some() {} },
    )
    .await;
    tasks.abort_all();
    let (done, stopped) = tokio::sync::oneshot::channel();
    apply(s, move |s| {
        let _ = done.send(s.stop());
    })
    .await;
    stopped.await??;
    Ok(())
}
fn main() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        // A worker panic must not leave a listening process with no state worker.
        // Report only an allowlisted class, never the panic text or credentials.
        let reporter = std::thread::spawn(|| {
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                runtime.block_on(report_error("server.fatal"));
            }
        });
        let _ = reporter.join();
        std::process::exit(1);
    }));
    let threads = std::env::var("TOKIO_WORKER_THREADS")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads)
        .enable_all()
        .build()
        .unwrap();
    if runtime.block_on(run()).is_err() {
        runtime.block_on(report_error(if LISTENING.load(Ordering::Relaxed) {
            "server.shutdown_failed"
        } else {
            "server.start_failed"
        }));
        eprintln!("Server startup or shutdown failed");
        std::process::exit(1)
    } // Do not wait for the stdin reader's blocking OS read on shutdown.
    runtime.shutdown_timeout(Duration::from_millis(100));
}
async fn report_error(name: &str) {
    if let Ok(Some(mut t)) = telemetry::Telemetry::new() {
        t.capture(name);
        let _ = tokio::time::timeout(Duration::from_millis(700), t.flush(true)).await;
    }
}
