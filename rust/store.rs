use crate::{model::*, protocol};
use anyhow::{Result, bail};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
pub struct Store {
    pub directory: PathBuf,
    pub enabled: bool,
    pub max: usize,
    pub jobs: IndexMap<String, Vec<Value>>,
}
impl Store {
    pub fn new(dir: &str, max: usize) -> Result<Self> {
        let mut s = Self {
            directory: dir.into(),
            enabled: !dir.is_empty(),
            max,
            jobs: IndexMap::new(),
        };
        if s.enabled {
            for f in ["rooms", "accounts", "notifications"] {
                fs::create_dir_all(s.directory.join(f))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(s.directory.join(f), fs::Permissions::from_mode(0o700))?;
                }
            }
            for entry in fs::read_dir(s.directory.join("notifications"))? {
                let path = entry?.path();
                let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if path.extension().is_none_or(|e| e != "json") || !protocol::uuid(&json!(id)) {
                    continue;
                }
                let jobs = fs::read(&path)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok())
                    .filter(|a| {
                        a.iter().all(|j| {
                            protocol::notice(j)
                                && j["done"]
                                    .as_array()
                                    .is_some_and(|a| a.iter().all(Value::is_string))
                                && protocol::integer(&j["retryAt"])
                                && j["scheduled"].is_boolean()
                        })
                    });
                if let Some(j) = jobs {
                    s.jobs.insert(id.to_owned(), j);
                } else {
                    eprintln!("unreadable notification file skipped")
                }
            }
            s.prune(&IndexSet::new())?;
        }
        Ok(s)
    }
    fn path(&self, folder: &str, id: &str) -> Result<PathBuf> {
        if !protocol::uuid(&json!(id)) {
            bail!("Invalid storage ID")
        };
        Ok(self.directory.join(folder).join(format!(
            "{}.{}",
            id.to_lowercase(),
            if folder == "rooms" { "bin" } else { "json" }
        )))
    }
    fn atomic(&self, path: &Path, parts: &[&[u8]]) -> Result<()> {
        let tmp = PathBuf::from(format!("{}.tmp", path.display()));
        let mut options = OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp)?;
        for p in parts {
            f.write_all(p)?
        }
        f.sync_all()?;
        drop(f);
        fs::rename(tmp, path)?;
        Ok(())
    }
    pub fn save_account(&self, p: &Player) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let devices: Vec<_> = p
            .devices
            .iter()
            .map(|(id, d)| {
                let mut d = d.clone();
                d["foreground"] = json!(false);
                json!([id, d])
            })
            .collect();
        self.atomic(
            &self.path("accounts", &p.id)?,
            &[&serde_json::to_vec(
                &json!({"id":p.id,"name":p.name,"password":p.password,"devices":devices}),
            )?],
        )
    }
    pub fn account(&self, id: &str) -> Result<Option<Player>> {
        if !self.enabled {
            return Ok(None);
        }
        let path = self.path("accounts", id)?;
        if !path.exists() {
            return Ok(None);
        }
        let v: Value = serde_json::from_slice(&fs::read(path)?)?;
        let mut p = Player::new(v["name"].as_str().unwrap_or("Player").into());
        p.id = v["id"].as_str().unwrap_or(id).into();
        p.password = v["password"].as_str().unwrap_or("").into();
        for d in v["devices"].as_array().into_iter().flatten() {
            if let Some(id) = d[0].as_str() {
                p.devices.insert(id.into(), d[1].clone());
            }
        }
        Ok(Some(p))
    }
    pub fn save(&self, r: &Room) -> Result<()> {
        let h = serde_json::to_vec(&r.header())?;
        self.atomic(
            &self.path("rooms", &r.id)?,
            &[&(h.len() as u32).to_be_bytes(), &h, &r.state],
        )
    }
    pub fn load(&self, id: &str, body: bool) -> Result<Option<Room>> {
        if !self.enabled {
            return Ok(None);
        }
        let path = self.path("rooms", id)?;
        if !path.exists() {
            return Ok(None);
        }
        let mut f = File::open(path)?;
        let mut prefix = [0; 4];
        f.read_exact(&mut prefix)?;
        let n = u32::from_be_bytes(prefix) as usize;
        if n > 1024 * 1024 {
            bail!("Invalid session header")
        };
        let mut h = vec![0; n];
        f.read_exact(&mut h)?;
        let v: Value = serde_json::from_slice(&h)?;
        if v["version"] != 1 || v["roomId"] != id {
            bail!("Unsupported session")
        };
        let mut r = Room::new(
            v["name"].as_str().unwrap_or("").into(),
            v["ownerId"].as_str().unwrap_or("").into(),
            v["maxPlayers"].as_u64().unwrap_or(1) as usize,
            v["password"].clone(),
            v["gameData"].clone(),
        );
        r.id = id.into();
        r.meta = v["metaData"].clone();
        r.start = v["startData"].clone();
        r.generation = v["generation"].as_u64().unwrap_or(0);
        r.binary = v["binaryRelay"] == true;
        r.revision = v["revision"].as_u64().unwrap_or(0);
        r.updated = v["updatedAt"].as_u64().unwrap_or(0);
        r.started = true;
        r.fixed = true;
        r.migration = true;
        r.persistent = true;
        for (key, set) in [("players", &mut r.players), ("events", &mut r.events)] {
            for s in v[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                set.insert(s.into());
            }
        }
        if body {
            let mut bytes = Vec::new();
            f.read_to_end(&mut bytes)?;
            r.state = bytes.into()
        }
        Ok(Some(r))
    }
    pub fn set_jobs(&mut self, id: &str, jobs: Vec<Value>) -> Result<()> {
        let path = self.path("notifications", id)?;
        if jobs.is_empty() {
            if path.exists() {
                fs::remove_file(path)?;
            }
            self.jobs.shift_remove(id);
        } else {
            self.atomic(&path, &[&serde_json::to_vec(&jobs)?])?;
            self.jobs.insert(id.into(), jobs);
        }
        Ok(())
    }
    pub fn commit(&mut self, r: &Room, scheduled: &Value, immediate: &Value) -> Result<()> {
        let previous = self.jobs.get(&r.id).cloned().unwrap_or_default();
        let mut jobs: Vec<_> = previous
            .iter()
            .filter(|j| j["scheduled"] != true && j["retryAt"] != 9007199254740991u64)
            .cloned()
            .collect();
        for (n, scheduled) in [(scheduled, true), (immediate, false)] {
            if n.is_null()
                || r.events.contains(n["eventId"].as_str().unwrap_or(""))
                || jobs.iter().any(|j| j["eventId"] == n["eventId"])
            {
                continue;
            }
            let j = previous
                .iter()
                .find(|j| j["eventId"] == n["eventId"] && j["at"] == n["at"])
                .cloned()
                .unwrap_or_else(|| {
                    let mut j = n.clone();
                    j["done"] = json!([]);
                    j["retryAt"] = json!(0);
                    j["scheduled"] = json!(scheduled);
                    j
                });
            jobs.push(j)
        }
        self.set_jobs(&r.id, jobs)
    }
    pub fn prune(&mut self, active: &IndexSet<String>) -> Result<Vec<String>> {
        if !self.enabled {
            return Ok(vec![]);
        }
        let mut entries = vec![];
        let mut total = 0;
        for e in fs::read_dir(self.directory.join("rooms"))? {
            let e = e?;
            let p = e.path();
            let Some(id) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if p.extension().is_none_or(|s| s != "bin") || !protocol::uuid(&json!(id)) {
                continue;
            }
            let size = e.metadata()?.len() as usize;
            total += size;
            if !active.contains(id) {
                let at = self.load(id, false).ok().flatten().map(|r| r.updated);
                entries.push((at, id.to_owned(), size));
            }
        }
        entries.sort();
        let mut removed = vec![];
        for (_, id, size) in entries {
            if total <= self.max {
                break;
            }
            fs::remove_file(self.path("rooms", &id)?)?;
            self.set_jobs(&id, vec![])?;
            total -= size;
            removed.push(id)
        }
        Ok(removed)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quota_evicts_corruption_and_protects_active_worlds() {
        let dir = std::env::temp_dir().join(format!("rust-relay-store-{}", id()));
        let mut s = Store::new(dir.to_str().unwrap(), 1024).unwrap();
        let mut r = Room::new("world".into(), id(), 2, Value::Null, Value::Null);
        r.state = vec![17; 2000].into();
        s.save(&r).unwrap();
        let corrupt = id();
        fs::write(s.path("rooms", &corrupt).unwrap(), [255; 20]).unwrap();
        let mut active = IndexSet::new();
        active.insert(r.id.clone());
        assert_eq!(s.prune(&active).unwrap(), vec![corrupt]);
        assert_eq!(s.load(&r.id, true).unwrap().unwrap().state, r.state);
        drop(s);
        fs::remove_dir_all(dir).unwrap();
    }
}
