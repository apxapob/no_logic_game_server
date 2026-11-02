use anyhow::Result;
use serde_json::{Value, json};
pub async fn read(pid: u32) -> Result<Value> {
    #[cfg(windows)]
    {
        let mut command = tokio::process::Command::new("powershell.exe");
        command.creation_flags(0x08000000);
        let output=tokio::time::timeout(std::time::Duration::from_secs(10),command.args(["-NoProfile","-NonInteractive","-Command",&format!("$p=Get-Process -Id {pid}; @{{cpuMs=$p.TotalProcessorTime.TotalMilliseconds; rssBytes=$p.WorkingSet64; peakRssBytes=$p.PeakWorkingSet64; privateBytes=$p.PrivateMemorySize64; handles=$p.HandleCount; threads=$p.Threads.Count}} | ConvertTo-Json -Compress")]).kill_on_drop(true).output()).await??;

        anyhow::ensure!(output.status.success(), "Get-Process failed");
        let parsed: Value = serde_json::from_slice(&output.stdout)?;
        Ok(json!(parsed))
    }
    #[cfg(not(windows))]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let fields = stat
            .rsplit_once(')')
            .ok_or_else(|| anyhow::anyhow!("Invalid /proc stat"))?
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
        let hz = tokio::process::Command::new("getconf")
            .arg("CLK_TCK")
            .output()
            .await?;
        anyhow::ensure!(hz.status.success(), "getconf failed");
        let hz = std::str::from_utf8(&hz.stdout)?.trim().parse::<f64>()?;
        let value = |name: &str| -> Result<u64> {
            Ok(status
                .lines()
                .find_map(|line| line.strip_prefix(name))
                .ok_or_else(|| anyhow::anyhow!("Missing {name}"))?
                .split_whitespace()
                .next()
                .unwrap()
                .parse()?)
        };
        Ok(
            json!({"cpuMs":(fields[11].parse::<f64>()?+fields[12].parse::<f64>()?)*1000./hz,"rssBytes":value("VmRSS:")?*1024,"peakRssBytes":value("VmHWM:")?*1024,"privateBytes":value("RssAnon:")?*1024,"threads":value("Threads:")?,"handles":std::fs::read_dir(format!("/proc/{pid}/fd"))?.count()}),
        )
    }
}
