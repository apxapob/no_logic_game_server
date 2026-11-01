use crate::config::Config;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc::{SyncSender, sync_channel},
    },
};
#[derive(Clone)]
pub struct Diagnostics {
    pub verbose: bool,
    tx: Option<SyncSender<LogEntry>>,
    queued: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    pub activity: Arc<Mutex<Value>>,
    pub errors: Arc<Mutex<Vec<Value>>>,
}
enum LogEntry {
    Line(String),
    Flush(std::sync::mpsc::Sender<()>),
}
pub fn redact(v: &mut Value) {
    match v {
        Value::Object(m) => {
            for (k, v) in m {
                let k = k.to_ascii_lowercase();
                if [
                    "password",
                    "passwd",
                    "secret",
                    "token",
                    "authorization",
                    "cookie",
                    "apikey",
                    "api_key",
                    "api-key",
                ]
                .iter()
                .any(|s| k.contains(s))
                {
                    *v = json!("[REDACTED]")
                } else {
                    redact(v)
                }
            }
        }
        Value::Array(a) => {
            for v in a {
                redact(v)
            }
        }
        _ => {}
    }
}
impl Diagnostics {
    pub fn new(c: &Config) -> Self {
        let verbose = c.b("verboseLogs");
        let queued = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let tx = if verbose && std::env::var_os("RELAY_TEST_CONTROL").is_none() {
            let (tx, rx) = sync_channel::<LogEntry>(256);
            let c = c.clone();
            let queue_bytes = queued.clone();
            let lost = dropped.clone();
            std::thread::spawn(move || {
                let mut logger = Logger::new(&c).ok();
                if logger.is_none() {
                    eprintln!("File logging failed; detailed logging disabled");
                }
                while let Ok(entry) = rx.recv() {
                    let line = match entry {
                        LogEntry::Line(line) => {
                            queue_bytes.fetch_sub(line.len(), Ordering::Relaxed);
                            line
                        }
                        LogEntry::Flush(done) => {
                            if let Some(l) = logger.as_mut() {
                                let count = lost.swap(0, Ordering::Relaxed);
                                if count > 0 {
                                    let _ = l.write(&json!({"time":chrono::Utc::now().to_rfc3339(),"event":"log.records_dropped","count":count}).to_string());
                                }
                                if let Some(f) = l.file.as_mut() {
                                    let _ = f.flush();
                                }
                            }
                            let _ = done.send(());
                            continue;
                        }
                    };
                    if let Some(l) = logger.as_mut()
                        && l.write(&line).is_err()
                    {
                        eprintln!("File logging failed; detailed logging disabled");
                        logger = None;
                    }
                }
            });
            Some(tx)
        } else {
            None
        };
        Self {
            verbose,
            tx,
            queued,
            dropped,
            activity: Arc::new(Mutex::new(json!({}))),
            errors: Arc::new(Mutex::new(Vec::new())),
        }
    }
    pub fn event(&self, event: &str, mut details: Value) {
        if *crate::TEST_CONTROL {
            println!("{}", json!({"observe":event,"details":details}));
        }
        let count = match event {
            "connection.connected" => "connections",
            "connection.disconnected" => "disconnects",
            "connection.terminate" => "terminated",
            "authentication.failed" => "authFailures",
            "authentication.succeeded" => "authSuccesses",
            "protocol.error" => "protocolErrors",
            "room.created" => "roomsCreated",
            "room.deleted" => "roomsDeleted",
            "room.entered" => "roomEntries",
            "room.left" => "roomLeaves",
            "room.owner_changed" => "ownerChanges",
            "room.game_started" => "gamesStarted",
            "connection.error" => "socketErrors",
            "transport.rejected" => "transportRejected",
            "transport.error" => "transportErrors",
            "transport.timeout" => "transportTimeouts",
            "upgrade.rejected" => "upgradeRejected",
            "upgrade.error" => "upgradeErrors",
            "message.discarded" => "messagesDiscarded",
            "message.not_sent" => "messagesNotSent",
            "account.expired" => "accountsExpired",
            _ => "",
        };
        if !count.is_empty() {
            let mut a = self.activity.lock().unwrap();
            let n = a[count].as_u64().unwrap_or(0);
            a[count] = json!(n.saturating_add(1));
            if event == "connection.terminate"
                && ["message_rate_limit", "output_buffer_limit"]
                    .contains(&details["reason"].as_str().unwrap_or(""))
            {
                let n = a["rateLimits"].as_u64().unwrap_or(0);
                a["rateLimits"] = json!(n.saturating_add(1));
            }
        }
        let error = match event {
            "http server error" => Some("server.http_error"),
            "websocket server error" => Some("server.websocket_error"),
            "server.start_failed" | "server.fatal" | "server.shutdown_failed" => Some(event),
            _ => None,
        };
        if let Some(name) = error {
            let mut errors = self.errors.lock().unwrap();
            let t = crate::model::now();
            if !errors.iter().any(|v| {
                v["name"] == name && t.saturating_sub(v["at"].as_u64().unwrap_or(0)) < 60000
            }) {
                errors.push(json!({"name":name,"at":t}));
                if errors.len() > 16 {
                    errors.remove(0);
                }
            }
        }
        if !self.verbose {
            if event == "server started" || event == "server stopped" {
                if std::env::var_os("RELAY_TEST_CONTROL").is_some() {
                    println!("{}", json!({"log":event}));
                } else {
                    println!("{}", json!({"event":event}));
                }
            }
            return;
        }
        details["time"] =
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        details["event"] = json!(event);
        let line = details.to_string();
        if let Some(tx) = &self.tx {
            let n = line.len();
            if self.queued.fetch_add(n, Ordering::Relaxed) + n > 8 * 1024 * 1024 {
                self.queued.fetch_sub(n, Ordering::Relaxed);
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
            if tx.try_send(LogEntry::Line(line)).is_err() {
                self.queued.fetch_sub(n, Ordering::Relaxed);
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        } else {
            println!("{}", json!({"log":line}));
        }
    }
    pub fn flush(&self) {
        if let Some(tx) = &self.tx {
            let (done, finished) = std::sync::mpsc::channel();
            if tx.send(LogEntry::Flush(done)).is_ok() {
                let _ = finished.recv_timeout(std::time::Duration::from_secs(2));
            }
        }
    }
}
struct Logger {
    dir: PathBuf,
    max: usize,
    file_max: usize,
    files: VecDeque<(PathBuf, usize)>,
    total: usize,
    seq: u64,
    file: Option<File>,
}
impl Logger {
    fn new(c: &Config) -> std::io::Result<Self> {
        let dir = PathBuf::from(c.s("logDirectory"));
        fs::create_dir_all(&dir)?;
        let mut files = vec![];
        let mut seq = 0;
        for e in fs::read_dir(&dir)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            if !e.file_type()?.is_file() {
                continue;
            }
            if let Some(n) = name
                .strip_prefix("server-")
                .and_then(|s| s.strip_suffix(".jsonl"))
                .filter(|s| s.len() == 20)
                .and_then(|s| s.parse::<u64>().ok())
            {
                seq = seq.max(n);
                files.push((e.path(), e.metadata()?.len() as usize));
            }
        }
        files.sort();
        let total = files.iter().map(|(_, n)| n).sum();
        let mut l = Self {
            dir,
            max: c.n("logMaxBytes"),
            file_max: c.n("logFileMaxBytes"),
            files: files.into(),
            total,
            seq,
            file: None,
        };
        l.room(0)?;
        Ok(l)
    }
    fn room(&mut self, n: usize) -> std::io::Result<()> {
        while self.total + n > self.max {
            let Some((p, size)) = self.files.pop_front() else {
                break;
            };
            if self.files.is_empty() {
                self.file = None
            }
            fs::remove_file(p)?;
            self.total -= size;
        }
        Ok(())
    }
    fn write(&mut self, line: &str) -> std::io::Result<()> {
        let mut line = line.to_owned() + "\n";
        if line.len() > self.max || line.len() > 8 * 1024 * 1024 {
            line=json!({"time":chrono::Utc::now().to_rfc3339(),"event":"log.record_too_large","bytes":line.len()}).to_string()+"\n"
        }
        if line.len() > self.max {
            return Ok(());
        }
        if self.file.is_some()
            && self
                .files
                .back()
                .is_some_and(|(_, n)| n + line.len() > self.file_max.min(self.max))
        {
            self.file = None;
        }
        self.room(line.len())?;
        if self.file.is_none() {
            self.seq += 1;
            let path = self.dir.join(format!("server-{:020}.jsonl", self.seq));
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            self.file = Some(options.open(&path)?);
            self.files.push_back((path, 0));
        }
        self.file.as_mut().unwrap().write_all(line.as_bytes())?;
        self.files.back_mut().unwrap().1 += line.len();
        self.total += line.len();
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotation_keeps_whole_unicode_records_and_respects_total_across_restart() {
        let dir = std::env::temp_dir().join(format!("rust-relay-logs-{}", crate::model::id()));
        let mut c = Config::load().unwrap();
        c.0["logDirectory"] = json!(dir.to_str().unwrap());
        c.0["logMaxBytes"] = json!(1024);
        c.0["logFileMaxBytes"] = json!(256);
        for batch in 0..2 {
            let mut l = Logger::new(&c).unwrap();
            for i in 0..100 {
                l.write(&json!({"i":batch*100+i,"text":"Привет 世界"}).to_string())
                    .unwrap();
            }
        }
        let mut total = 0;
        let mut records = vec![];
        for entry in fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            let b = fs::read(p).unwrap();
            total += b.len();
            for line in std::str::from_utf8(&b).unwrap().lines() {
                records.push(serde_json::from_str::<Value>(line).unwrap());
            }
        }
        assert!(total <= 1024);
        assert!(records.iter().any(|v| v["i"] == 199));
        assert!(records.iter().all(|v| v["text"] == "Привет 世界"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn redaction_is_recursive_and_does_not_change_the_original() {
        let original = json!({"nested":[{"accessToken":"private","password":"secret","ok":7}]});
        let mut copy = original.clone();
        redact(&mut copy);
        assert_eq!(copy["nested"][0]["accessToken"], "[REDACTED]");
        assert_eq!(copy["nested"][0]["ok"], 7);
        assert_eq!(original["nested"][0]["password"], "secret");
    }
}
