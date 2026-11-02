//! The state worker owns the relay. Async tasks enqueue work without blocking
//! their executor on a mutex held during persistence or protocol processing.
use crate::{diagnostics::Diagnostics, server::Server};
use anyhow::Result;
use tokio::sync::{mpsc, oneshot};

type Command = Box<dyn FnOnce(&mut Server) + Send>;

#[derive(Clone)]
pub struct Shared {
    pub diagnostics: Diagnostics,
    commands: mpsc::Sender<Command>,
}

impl Shared {
    pub fn new(mut server: Server) -> Self {
        let diagnostics = server.diagnostics.clone();
        let (commands, mut receiver) = mpsc::channel::<Command>(256);
        std::thread::Builder::new()
            .name("relay-state".into())
            .spawn(move || {
                while let Some(command) = receiver.blocking_recv() {
                    command(&mut server);
                    crate::snapshot(&server);
                }
            })
            .expect("state worker");
        Self {
            diagnostics,
            commands,
        }
    }

    pub async fn apply(&self, f: impl FnOnce(&mut Server) + Send + 'static) {
        let _ = self.commands.send(Box::new(f)).await;
    }

    pub async fn query<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Server) -> T + Send + 'static,
    ) -> Result<T> {
        let (done, result) = oneshot::channel();
        self.apply(move |s| {
            let _ = done.send(f(s));
        })
        .await;
        Ok(result.await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use serde_json::json;
    use std::{sync::Arc, time::Duration};

    fn server() -> Shared {
        let mut config = Config::load().unwrap();
        config.0["sessionDirectory"] = json!("");
        config.0["verboseLogs"] = json!(false);
        Shared::new(Server::new(config).unwrap())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn waiting_for_state_keeps_the_async_executor_responsive() {
        let state = server();
        let (started, ready) = oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        state
            .apply(move |s| {
                let _ = started.send(());
                // An async task must be able to run and release this blocked work.
                let responsive = wait.recv_timeout(Duration::from_secs(2)).is_ok();
                s.config.0["testResponsive"] = json!(responsive);
            })
            .await;
        ready.await.unwrap();
        let (responsive, ()) = tokio::join!(state.query(|s| s.config.b("testResponsive")), async {
            tokio::task::yield_now().await;
            let _ = release.send(());
        });
        assert!(responsive.unwrap());
    }

    #[tokio::test]
    async fn dropping_last_sender_releases_the_worker_and_its_state() {
        let state = server();
        let allocation = Arc::downgrade(&state.diagnostics.activity);
        state.query(|_| ()).await.unwrap();
        drop(state);
        tokio::time::timeout(Duration::from_secs(2), async {
            while allocation.upgrade().is_some() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
}
