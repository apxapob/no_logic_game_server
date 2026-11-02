use anyhow::{Result, bail};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Command,
};
#[tokio::test]
async fn demo_browser_regressions() -> Result<()> {
    let browser = if let Some(path) = std::env::var_os("CHROME_BIN") {
        PathBuf::from(path)
    } else if cfg!(windows) {
        [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .ok_or_else(|| anyhow::anyhow!("Install Edge/Chrome or set CHROME_BIN for browser tests"))?
    } else {
        PathBuf::from("google-chrome")
    };
    let demo = include_str!("../demo.html")
        .split_once("<script>")
        .unwrap()
        .1
        .split_once("</script>")
        .unwrap()
        .0;
    let html = format!(
        "<!doctype html><body><script>const demoSource={};{}</script>",
        serde_json::to_string(demo)?,
        include_str!("browser/demo-cases.js")
    );
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/", listener.local_addr()?);
    let serving = tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let html = html.clone();
            tokio::spawn(async move {
                let mut buf = [0; 8192];
                let _ = tokio::time::timeout(Duration::from_secs(3), tcp.read(&mut buf)).await;
                let _=tcp.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",html.len()).as_bytes()).await;
            });
        }
    });
    let profile = std::env::temp_dir().join(format!("relay-browser-{}", uuid::Uuid::new_v4()));
    let output = tokio::time::timeout(
        Duration::from_secs(45),
        Command::new(browser)
            .args([
                "--headless",
                "--disable-gpu",
                "--no-sandbox",
                "--no-first-run",
                "--disable-background-networking",
                "--dump-dom",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(url)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    serving.abort();
    let _ = std::fs::remove_dir_all(profile);
    let output = output??;
    let dom = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !dom.contains("data-result=\"passed\"") {
        bail!(
            "Browser regressions failed: {dom}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}
