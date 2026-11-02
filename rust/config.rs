use anyhow::{Result, bail};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct Config(pub Value);
impl Config {
    pub fn load() -> Result<Self> {
        let mut v = json!({"host":"127.0.0.1","port":8080,"devMode":false,"sendDelayMs":0,
            "udpEnabled":false,"udpHost":"127.0.0.1","udpPort":8080,
            "maxPayloadBytes":65536,"maxBufferedBytes":262144,"maxConnections":256,
            "maxConnectionsPerIp":32,"maxAccounts":1024,"maxRooms":128,"maxRoomPlayers":16,
            "maxMessagesPerSecond":120,"maxConnectionsPerMinute":60,"accountTtlMs":300000,
            "heartbeatIntervalMs":10000,"idleTimeoutMs":50000,"authTimeoutMs":5000,
            "maintenanceIntervalMs":1000,"shutdownTimeoutMs":1000,
            "allowedOrigins":["http://127.0.0.1:8081","http://localhost:8081"],"allowNoOrigin":true,
            "verboseLogs":false,"logDirectory":"./logs","logMaxBytes":1073741824,"logFileMaxBytes":16777216,
            "sessionDirectory":"./sessions","sessionMaxBytes":1073741824,"maxSessionBytes":16777216});
        for (k, value) in v.as_object_mut().unwrap() {
            let env_key = k.chars().fold(String::new(), |mut s, c| {
                if c.is_uppercase() {
                    s.push('_')
                };
                s.extend(c.to_uppercase());
                s
            });
            if let Ok(s) = std::env::var(&env_key) {
                *value = if value.is_boolean() {
                    match s.as_str() {
                        "true" => json!(true),
                        "false" => json!(false),
                        _ => bail!("Invalid setting: {env_key}"),
                    }
                } else if value.is_number() {
                    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
                        bail!("Invalid setting: {env_key}")
                    }
                    let n: u64 = s.parse()?;
                    let max = if k == "port" || k == "udpPort" {
                        65535
                    } else if ["logMaxBytes", "logFileMaxBytes", "sessionMaxBytes"]
                        .contains(&k.as_str())
                    {
                        9007199254740991
                    } else {
                        2147483647
                    };
                    if n > max || (n == 0 && k != "port" && k != "udpPort" && k != "sendDelayMs") {
                        bail!("Invalid setting: {env_key}")
                    };
                    json!(n)
                } else if value.is_array() {
                    json!(
                        s.split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                    )
                } else {
                    json!(s)
                };
            }
        }
        for arg in std::env::args().skip(1) {
            if arg == "dev" {
                v["devMode"] = json!(true)
            }
            if let Some(s) = arg.strip_prefix("delay=") {
                if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
                    bail!("Invalid delay")
                }
                let delay = s.parse::<u32>()?;
                if delay > 2147483647 {
                    bail!("Invalid delay")
                }
                v["sendDelayMs"] = json!(delay)
            }
        }
        if v["host"].as_str().unwrap().trim().is_empty()
            || v["udpHost"].as_str().unwrap().trim().is_empty()
            || v["logDirectory"].as_str().unwrap().trim().is_empty()
        {
            bail!("Invalid server options")
        }
        let re = regex::Regex::new(r"^https?://[^\s/?#]+$")?;
        if v["allowedOrigins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| !re.is_match(s.as_str().unwrap()))
        {
            bail!("Invalid origins")
        }
        Ok(Self(v))
    }
    pub fn n(&self, k: &str) -> usize {
        self.0[k].as_u64().unwrap_or(0) as usize
    }
    pub fn b(&self, k: &str) -> bool {
        self.0[k].as_bool().unwrap_or(false)
    }
    pub fn s(&self, k: &str) -> &str {
        self.0[k].as_str().unwrap_or("")
    }
}
