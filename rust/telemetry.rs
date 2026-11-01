use crate::{
    Shared,
    model::{id, now},
};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{collections::VecDeque, time::Duration};
pub struct Telemetry {
    url: String,
    key: String,
    project: String,
    release: String,
    pub interval: u64,
    client: reqwest::Client,
    queue: VecDeque<Value>,
    dropped: u64,
    failures: u32,
    next: u64,
    session: String,
    started: u64,
    window: u64,
}
impl Telemetry {
    pub fn new() -> Result<Option<Self>> {
        let env = |k: &str| std::env::var(k).ok();
        let enabled = env("TELEMETRY_ENABLED");
        if enabled.as_deref() == Some("false") {
            return Ok(None);
        }
        if enabled.as_deref().is_some_and(|s| s != "true") {
            bail!("Invalid telemetry switch")
        }
        let url = env("TELEMETRY_URL").unwrap_or_default().trim().to_owned();
        let key = env("TELEMETRY_WRITE_KEY")
            .unwrap_or_default()
            .trim()
            .to_owned();
        if enabled.as_deref() == Some("true") && (url.is_empty() || key.is_empty()) {
            bail!("Missing telemetry settings")
        }
        if !url.is_empty() {
            let u = reqwest::Url::parse(&url)?;
            if u.scheme() != "https"
                || !u.username().is_empty()
                || u.password().is_some()
                || u.query().is_some()
                || u.fragment().is_some()
            {
                bail!("Invalid telemetry URL")
            }
        }
        if !key.is_empty()
            && (!(24..=128).contains(&key.len())
                || !key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'))
        {
            bail!("Invalid telemetry key")
        }
        let project = env("TELEMETRY_PROJECT").unwrap_or("no-logic".into());
        let release = env("TELEMETRY_RELEASE").unwrap_or("1.0.0".into());
        if !regex::Regex::new(r"^[a-z0-9][a-z0-9_-]{0,63}$")?.is_match(&project)
            || !regex::Regex::new(r"^[a-zA-Z0-9._+\-]{1,64}$")?.is_match(&release)
        {
            bail!("Invalid telemetry identifiers")
        }
        let number = |k: &str, fallback: u64, min, max| -> Result<u64> {
            let Some(s) = env(k) else { return Ok(fallback) };
            if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
                bail!("Invalid telemetry number")
            }
            let n = s.parse()?;
            if n < min || n > max {
                bail!("Invalid telemetry number")
            }
            Ok(n)
        };
        let interval = number("TELEMETRY_INTERVAL_MS", 60000, 1000, 3600000)?;
        let timeout = number("TELEMETRY_TIMEOUT_MS", 5000, 100, 30000)?;
        if url.is_empty() || key.is_empty() {
            return Ok(None);
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let t = now();
        Ok(Some(Self {
            url,
            key,
            project,
            release,
            interval,
            client,
            queue: VecDeque::new(),
            dropped: 0,
            failures: 0,
            next: 0,
            session: id(),
            started: t,
            window: t,
        }))
    }
    pub fn enqueue(&mut self, name: &str, properties: Value) {
        self.queue.push_back(json!({"id":id(),"timestamp":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"type":"event","name":name,"sessionId":self.session,"release":self.release,"platform":format!("rust-{}",std::env::consts::OS),"properties":properties}));
        while self.queue.len() > 256
            || self
                .queue
                .iter()
                .map(|v| v.to_string().len())
                .sum::<usize>()
                > 512 * 1024
        {
            self.queue.pop_front();
            self.dropped += 1;
        }
    }
    pub async fn sample(&mut self, s: Shared) {
        let t = now();
        let mut stats = {
            let s = s.lock().unwrap();
            for error in s.diagnostics.errors.lock().unwrap().drain(..) {
                self.capture(error["name"].as_str().unwrap_or("server.fatal"));
            }
            let mut activity = s.diagnostics.activity.lock().unwrap();
            if activity.as_object().is_some_and(|a| !a.is_empty()) {
                let mut data = std::mem::replace(&mut *activity, json!({}));
                data["windowMs"] = json!(t.saturating_sub(self.window));
                self.enqueue("server.activity", data)
            }
            s.stats()
        };
        self.window = t;
        stats["rssBytes"] = json!(
            memory_stats::memory_stats()
                .map(|m| m.physical_mem)
                .unwrap_or(0)
        );
        stats["uptimeSeconds"] = json!(t.saturating_sub(self.started) / 1000);
        stats["telemetryDropped"] = json!(self.dropped);
        self.enqueue("server.metrics", stats);
        self.flush(false).await;
    }
    pub fn capture(&mut self, name: &str) {
        self.enqueue(name, json!({}));
        if let Some(v) = self.queue.back_mut() {
            v["type"] = json!("error");
            v["error"] = json!({"name":"Error","message":name});
        }
    }
    pub async fn close(&mut self) {
        self.enqueue("server.stopped", json!({"telemetryDropped":self.dropped}));
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            for _ in 0..9 {
                self.flush(true).await;
                if self.queue.is_empty() || self.failures > 0 {
                    break;
                }
            }
        })
        .await;
    }
    pub async fn flush(&mut self, force: bool) {
        if self.queue.is_empty() || (!force && now() < self.next) {
            return;
        }
        let mut batch = vec![];
        let mut bytes = 128;
        while let Some(v) = self.queue.front() {
            let n = v.to_string().len() + 1;
            if batch.len() >= 32 || bytes + n > 64 * 1024 {
                break;
            }
            bytes += n;
            batch.push(self.queue.pop_front().unwrap());
        }
        let response = self
            .client
            .post(&self.url)
            .bearer_auth(&self.key)
            .json(&json!({"project":self.project,"events":batch}))
            .send()
            .await;
        match response {
            Ok(r) if r.status().is_success() => {
                self.failures = 0;
                self.next = 0
            }
            Ok(r)
                if r.status().is_client_error()
                    && r.status().as_u16() != 408
                    && r.status().as_u16() != 429 =>
            {
                self.dropped += batch.len() as u64;
                self.failures = 0;
                self.next = now() + 60000
            }
            _ => {
                self.failures = (self.failures + 1).min(10);
                self.next = now() + (1000 * (1u64 << (self.failures - 1))).min(300000);
                for v in batch.into_iter().rev() {
                    self.queue.push_front(v)
                }
                while self.queue.len() > 256 {
                    self.queue.pop_back();
                    self.dropped += 1;
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn retries_preserve_ids_and_queue_is_bounded() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = tokio::spawn(async move {
            let mut batches = vec![];
            for code in [503, 200] {
                let (mut tcp, _) = listener.accept().await.unwrap();
                let mut b = vec![];
                loop {
                    let mut chunk = [0; 4096];
                    let n = tcp.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    b.extend_from_slice(&chunk[..n]);
                    if let Some(end) = b.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&b[..end]).to_lowercase();
                        let length = header
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse::<usize>()
                            .unwrap();
                        if b.len() >= end + 4 + length {
                            batches.push(
                                serde_json::from_slice::<Value>(&b[end + 4..end + 4 + length])
                                    .unwrap(),
                            );
                            break;
                        }
                    }
                }
                tcp.write_all(
                    format!(
                        "HTTP/1.1 {code} Response\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            }
            batches
        });
        let mut t = Telemetry {
            url: format!("http://127.0.0.1:{port}/"),
            key: "test-only".into(),
            project: "no-logic".into(),
            release: "test".into(),
            interval: 1000,
            client: reqwest::Client::new(),
            queue: VecDeque::new(),
            dropped: 0,
            failures: 0,
            next: 0,
            session: id(),
            started: now(),
            window: now(),
        };
        for i in 0..300 {
            t.enqueue("server.metrics", json!({"i":i}));
        }
        assert_eq!(t.queue.len(), 256);
        assert_eq!(t.dropped, 44);
        t.flush(true).await;
        assert_eq!(t.failures, 1);
        assert_eq!(t.queue.len(), 256);
        assert!(t.next > now());
        t.flush(true).await;
        assert_eq!(t.failures, 0);
        assert_eq!(t.queue.len(), 224);
        let batches = worker.await.unwrap();
        assert_eq!(batches[0], batches[1]);
        assert_eq!(batches[0]["events"].as_array().unwrap().len(), 32);
    }
}
