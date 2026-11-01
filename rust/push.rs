use crate::{Shared, model::now};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
pub struct LegacyPush {
    pub player: String,
    pub device: String,
    pub token: String,
    pub notice: Value,
}
pub struct Sender {
    client: reqwest::Client,
    provider: Option<Arc<dyn gcp_auth::TokenProvider>>,
    url: String,
}
impl Sender {
    pub async fn deliver_legacy(&self, state: Shared) {
        let jobs = {
            let mut s = state.lock().unwrap();
            std::mem::take(&mut s.legacy_pushes)
        };
        futures_util::future::join_all(jobs.into_iter().map(|job| {
            let state = state.clone();
            async move {
                let result = self.send(&job.token, &job.notice).await;
                let mut s = state.lock().unwrap();
                s.pushes_in_flight = s.pushes_in_flight.saturating_sub(1);
                if matches!(result, Ok(false))
                    && let Some(p) = s.players.get_mut(&job.player)
                    && p.devices
                        .get(&job.device)
                        .is_some_and(|d| d["token"] == job.token)
                {
                    p.devices.shift_remove(&job.device);
                }
                s.diagnostics.event(
                    if result.is_ok() {
                        "push.delivery"
                    } else {
                        "push.delivery_failed"
                    },
                    json!({}),
                );
            }
        }))
        .await;
    }
    pub async fn new() -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        if std::env::var_os("RELAY_TEST_CONTROL").is_some()
            && let Ok(url) = std::env::var("RELAY_TEST_PUSH_URL")
        {
            return Ok(Self {
                client,
                provider: None,
                url,
            });
        }
        let provider = gcp_auth::provider().await?;
        let project = std::env::var("GOOGLE_CLOUD_PROJECT")
            .or_else(|_| std::env::var("GCLOUD_PROJECT"))
            .ok();
        let project = match project {
            Some(p) => p,
            None => provider.project_id().await?.to_string(),
        };
        if !project
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            bail!("Invalid project")
        };
        Ok(Self {
            client,
            provider: Some(provider),
            url: format!("https://fcm.googleapis.com/v1/projects/{project}/messages:send"),
        })
    }
    async fn send(&self, token: &str, n: &Value) -> Result<bool> {
        let mut request = self.client.post(&self.url);
        if let Some(provider) = &self.provider {
            let t = provider
                .token(&["https://www.googleapis.com/auth/firebase.messaging"])
                .await?;
            request=request.bearer_auth(t.as_str()).json(&json!({"message":{"token":token,"notification":{"title":n["title"],"body":n["body"]},"data":{"roomId":n["roomId"],"eventId":n["eventId"]},"android":{"priority":"high","ttl":"300s","collapse_key":n["roomId"],"notification":{"channel_id":"game_updates","tag":n["roomId"],"title":n["title"],"body":n["body"]}}}}));
        } else {
            request = request.json(&json!({"token":token,"notification":n}));
        }
        let response = request.send().await?;
        if response.status().is_success() {
            let v: Value = response.json().await.unwrap_or(Value::Null);
            return Ok(v["result"] != "invalid");
        }
        let v: Value = response.json().await.unwrap_or(Value::Null);
        if v["error"]["details"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v["errorCode"] == "UNREGISTERED"))
        {
            return Ok(false);
        }
        bail!("Push delivery failed")
    }
    pub async fn deliver(&self, state: Shared) {
        let s = state.clone();
        let due = tokio::task::spawn_blocking(move || {
            let s = s.lock().unwrap();
            let t = now();
            s.store
                .jobs
                .iter()
                .flat_map(|(id, jobs)| {
                    jobs.iter()
                        .filter(move |j| {
                            j["at"].as_u64().unwrap_or(0) <= t
                                && j["retryAt"].as_u64().unwrap_or(0) <= t
                        })
                        .map(|j| (id.clone(), j.clone()))
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for (room, job) in due {
            let mut failed = false;
            let targets = job["to"].as_array().cloned().unwrap_or_default();
            for id in targets {
                let Some(id) = id.as_str() else { continue };
                let (s, player) = (state.clone(), id.to_owned());
                let devices = tokio::task::spawn_blocking(move || {
                    let s = s.lock().unwrap();
                    s.players
                        .get(&player)
                        .cloned()
                        .or_else(|| s.store.account(&player).ok().flatten())
                        .map(|p| (p.connection.is_some(), p.room, p.devices))
                })
                .await
                .ok()
                .flatten();
                let Some((online, current, devices)) = devices else {
                    continue;
                };
                for (device_id, device) in devices {
                    let key = format!("{id}:{device_id}");
                    if job["done"]
                        .as_array()
                        .is_some_and(|a| a.contains(&json!(key)))
                    {
                        continue;
                    }
                    let still_current = {
                        let s = state.lock().unwrap();
                        s.store.jobs.get(&room).is_some_and(|a| {
                            a.iter()
                                .any(|j| j["eventId"] == job["eventId"] && j["at"] == job["at"])
                        })
                    };
                    if !still_current {
                        break;
                    }
                    let foreground =
                        online && device["foreground"] == true && current.as_deref() == Some(&room);
                    let localized =
                        &job["translations"][device["language"].as_str().unwrap_or("en")];
                    let text = if localized.is_object() {
                        localized
                    } else {
                        &job
                    };
                    let n = json!({"title":text["title"],"body":text["body"],"roomId":room,"eventId":job["eventId"]});
                    let result = if foreground {
                        Ok(true)
                    } else {
                        self.send(device["token"].as_str().unwrap_or(""), &n).await
                    };
                    if result.is_err() {
                        failed = true;
                        continue;
                    }
                    let (s, room, job, id, device_id) = (
                        state.clone(),
                        room.clone(),
                        job.clone(),
                        id.to_owned(),
                        device_id.clone(),
                    );
                    let invalid = matches!(result, Ok(false));
                    let token = device["token"].clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let mut s = s.lock().unwrap();
                        if invalid {
                            let mut p = s
                                .players
                                .get(&id)
                                .cloned()
                                .or_else(|| s.store.account(&id).ok().flatten());
                            if let Some(p) = p.as_mut()
                                && p.devices
                                    .get(&device_id)
                                    .is_some_and(|d| d["token"] == token)
                            {
                                p.devices.shift_remove(&device_id);
                                let _ = s.store.save_account(p);
                                if s.players.contains_key(&id) {
                                    s.players.insert(id.clone(), p.clone());
                                }
                            }
                        }
                        if let Some(j) = s.store.jobs.get_mut(&room).and_then(|a| {
                            a.iter_mut()
                                .find(|j| j["eventId"] == job["eventId"] && j["at"] == job["at"])
                        }) && let Some(done) = j["done"].as_array_mut()
                        {
                            done.push(json!(key));
                        }
                    })
                    .await;
                }
            }
            let s = state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let mut s = s.lock().unwrap();
                let Some(mut jobs) = s.store.jobs.get(&room).cloned() else {
                    return;
                };
                let Some(index) = jobs
                    .iter()
                    .position(|j| j["eventId"] == job["eventId"] && j["at"] == job["at"])
                else {
                    return;
                };
                if !failed && job["scheduled"] != true {
                    jobs.remove(index);
                } else {
                    jobs[index]["retryAt"] = json!(if failed {
                        now() + 30000
                    } else {
                        9007199254740991
                    });
                }
                if s.store.enabled {
                    let _ = s.store.set_jobs(&room, jobs);
                } else if jobs.is_empty() {
                    s.store.jobs.shift_remove(&room);
                } else {
                    s.store.jobs.insert(room, jobs);
                }
            })
            .await;
        }
    }
}
