use crate::{config::Config, model::now};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct Admission {
    active: HashMap<String, usize>,
    total: usize,
    attempts: HashMap<String, (u64, usize)>,
}

impl Admission {
    pub fn acquire(shared: &Arc<Mutex<Self>>, ip: String, cfg: &Config) -> Option<Permit> {
        let mut state = shared.lock().unwrap();
        let time = now();
        state
            .attempts
            .retain(|_, (at, _)| time.saturating_sub(*at) < 60000);
        // Reject an unknown address before allocating a tracker entry. Otherwise
        // rejected connections from distinct addresses could exceed its bound.
        if !state.attempts.contains_key(&ip) && state.attempts.len() >= cfg.n("maxConnections") * 4
        {
            return None;
        }
        let entry = state.attempts.entry(ip.clone()).or_insert((time, 0));
        entry.1 = entry.1.saturating_add(1);
        if entry.1 > cfg.n("maxConnectionsPerMinute")
            || state.total >= cfg.n("maxConnections")
            || state.active.get(&ip).copied().unwrap_or(0) >= cfg.n("maxConnectionsPerIp")
        {
            return None;
        }
        state.total += 1;
        *state.active.entry(ip.clone()).or_default() += 1;
        Some(Permit {
            ip,
            admission: shared.clone(),
        })
    }
}

pub struct Permit {
    ip: String,
    admission: Arc<Mutex<Admission>>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.admission.lock().unwrap();
        state.total -= 1;
        if let Some(count) = state.active.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                state.active.remove(&self.ip);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejected_addresses_cannot_grow_the_attempt_map_or_lock_out_known_addresses() {
        let mut cfg = Config::load().unwrap();
        cfg.0["maxConnections"] = json!(1);
        let state = Arc::new(Mutex::new(Admission::default()));
        for i in 0..4 {
            drop(Admission::acquire(&state, format!("ip-{i}"), &cfg).unwrap());
        }
        for i in 4..1000 {
            assert!(Admission::acquire(&state, format!("ip-{i}"), &cfg).is_none());
        }
        assert_eq!(state.lock().unwrap().attempts.len(), 4);
        let permit = Admission::acquire(&state, "ip-0".into(), &cfg).unwrap();
        assert!(Admission::acquire(&state, "ip-1".into(), &cfg).is_none());
        drop(permit);
        assert!(state.lock().unwrap().active.is_empty());
        for (at, _) in state.lock().unwrap().attempts.values_mut() {
            *at = now() - 60001;
        }
        drop(Admission::acquire(&state, "new-ip".into(), &cfg).unwrap());
        assert_eq!(state.lock().unwrap().attempts.len(), 1);
    }
}
