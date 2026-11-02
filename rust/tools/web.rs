use anyhow::Result;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

async fn serve(mut tcp: TcpStream) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = tcp.read(&mut buffer).await?;
        if n == 0 || bytes.len() + n > 8192 {
            return Ok(());
        }
        bytes.extend(&buffer[..n]);
    }
    let text = String::from_utf8_lossy(&bytes);
    let parts = text
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>();
    let method = parts.first().copied().unwrap_or("");
    let path = parts.get(1).copied().unwrap_or("");
    // Never map a URL to the filesystem: credentials may be next to the executable.
    let (status, body) = if !["GET", "HEAD"].contains(&method) {
        ("405 Method Not Allowed", "")
    } else if !["/", "/demo.html"].contains(&path) {
        ("404 Not Found", "")
    } else {
        ("200 OK", include_str!("../../demo.html"))
    };
    let length = body.len();
    let content = if method == "HEAD" { "" } else { body };
    tcp.write_all(format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {length}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nAllow: GET, HEAD\r\nConnection: close\r\n\r\n{content}"
    ).as_bytes()).await
}

pub async fn demo() -> Result<()> {
    let port = super::number("DEMO_PORT", 8081, 0, 65535)? as u16;
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    println!("Demo: http://{}", listener.local_addr()?);
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (tcp, _) = accepted?;
                if tasks.len() < 256 {
                    tasks.spawn(tokio::time::timeout(Duration::from_secs(5), serve(tcp)));
                }
            }
        }
    }
    tasks.abort_all();
    Ok(())
}
