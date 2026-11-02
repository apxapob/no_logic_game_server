use anyhow::Result;
use std::process::Stdio;
use tokio::{io::AsyncWriteExt, process::Command};
async fn run(env: &[(&str, &str)], args: &[&str]) -> Result<std::process::Output> {
    let mut c = Command::new(env!("CARGO_BIN_EXE_no-logic-game-server"))
        .args(args)
        .env_remove("RELAY_TEST_CONTROL")
        .envs([
            ("HOST", "127.0.0.1"),
            ("PORT", "0"),
            ("SESSION_DIRECTORY", ""),
            ("VERBOSE_LOGS", "false"),
            ("FCM_ENABLED", "false"),
            ("TELEMETRY_ENABLED", "false"),
        ])
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    c.stdin.take().unwrap().write_all(b"stop\n").await?;
    Ok(tokio::time::timeout(std::time::Duration::from_secs(5), c.wait_with_output()).await??)
}
#[tokio::test]
async fn cli_configuration_validation() -> Result<()> {
    for (key, values) in [
        ("PORT", vec!["-1", "65536", "1.5", "80x", "NaN", ""]),
        ("UDP_PORT", vec!["-1", "65536", "1.5", ""]),
        ("UDP_ENABLED", vec!["yes", "1"]),
        ("UDP_HOST", vec![""]),
        ("MAX_CONNECTIONS", vec!["0", "-1", "3.5", "1x"]),
        ("ALLOW_NO_ORIGIN", vec!["yes", "1", ""]),
        ("VERBOSE_LOGS", vec!["TRUE"]),
        ("MAX_SESSION_BYTES", vec!["2147483648"]),
        ("SEND_DELAY_MS", vec!["-1"]),
    ] {
        for value in values {
            assert!(
                !run(&[(key, value)], &[]).await?.status.success(),
                "{key}={value}"
            );
        }
    }
    for arg in ["delay=", "delay=-1", "delay=1.5", "delay=1x"] {
        assert!(!run(&[], &[arg]).await?.status.success());
    }
    for origin in ["null", "https://game.example.com/path", "ftp://example.com"] {
        assert!(
            !run(&[("ALLOWED_ORIGINS", origin)], &[])
                .await?
                .status
                .success()
        );
    }
    for (env, args) in [
        (
            vec![
                ("SEND_DELAY_MS", "0"),
                ("ALLOW_NO_ORIGIN", "false"),
                (
                    "ALLOWED_ORIGINS",
                    " https://game.example.com, http://localhost:8081 ",
                ),
            ],
            vec![],
        ),
        (vec![], vec!["dev", "delay=0"]),
    ] {
        let out = run(&env, &args).await?;
        assert!(out.status.success(), "{:?}", out);
        assert!(String::from_utf8_lossy(&out.stdout).contains("server.listening"));
    }
    for enabled in ["false", "true"] {
        let out = run(
            &[
                ("TELEMETRY_ENABLED", enabled),
                ("TELEMETRY_URL", "http://invalid.example/path?secret=x"),
                ("TELEMETRY_WRITE_KEY", "unused"),
                ("TELEMETRY_INTERVAL_MS", "bad"),
            ],
            &[],
        )
        .await?;
        assert_eq!(out.status.success(), enabled == "false");
    }
    Ok(())
}
