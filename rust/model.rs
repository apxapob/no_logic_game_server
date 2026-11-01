use bytes::Bytes;
use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};
use uuid::Uuid;
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}
#[derive(Clone)]
pub struct Player {
    pub id: String,
    pub name: String,
    pub password: String,
    pub connection: Option<u64>,
    pub room: Option<String>,
    pub entered: Option<u64>,
    pub rtt: Option<u64>,
    pub offline: Option<u64>,
    pub version: u64,
    pub devices: IndexMap<String, Value>,
}
impl Player {
    pub fn new(name: String) -> Self {
        use base64::Engine;
        let secret: [u8; 32] = rand::random();
        Self {
            id: id(),
            name,
            password: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret),
            connection: None,
            room: None,
            entered: None,
            rtt: None,
            offline: Some(now()),
            version: 0,
            devices: IndexMap::new(),
        }
    }
    pub fn dto(&self) -> Value {
        json!({"playerId":self.id,"name":self.name,"rtt":self.rtt,"roomEntryTimestamp":self.entered})
    }
}
pub struct Upload {
    pub id: String,
    pub owner: String,
    pub generation: u64,
    pub revision: u64,
    pub bytes: Vec<u8>,
    pub offset: usize,
    pub at: u64,
}
pub struct Room {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub max: usize,
    pub password: Value,
    pub game: Value,
    pub meta: Value,
    pub active: IndexSet<String>,
    pub reservations: IndexSet<String>,
    pub players: IndexSet<String>,
    pub events: IndexSet<String>,
    pub started: bool,
    pub closed: bool,
    pub fixed: bool,
    pub migration: bool,
    pub generation: u64,
    pub binary: bool,
    pub persistent: bool,
    pub start: Value,
    pub state: Bytes,
    pub revision: u64,
    pub updated: u64,
    pub upload: Option<Upload>,
    pub last_push: u64,
}
impl Room {
    pub fn new(name: String, owner: String, max: usize, password: Value, game: Value) -> Self {
        Self {
            id: id(),
            name,
            owner,
            max,
            password,
            game,
            meta: Value::Null,
            active: IndexSet::new(),
            reservations: IndexSet::new(),
            players: IndexSet::new(),
            events: IndexSet::new(),
            started: false,
            closed: false,
            fixed: false,
            migration: false,
            generation: 0,
            binary: false,
            persistent: false,
            start: Value::Null,
            state: Bytes::new(),
            revision: 0,
            updated: now(),
            upload: None,
            last_push: 0,
        }
    }
    pub fn rejoin(&self, p: &str) -> bool {
        if self.fixed {
            self.players.contains(p)
        } else {
            self.reservations.contains(p)
        }
    }
    pub fn dto(&self, rtt: Option<u64>) -> Value {
        let mut v = json!({"roomId":self.id,"ownerId":self.owner,"name":self.name,"players":self.active,"maxPlayers":self.max,"hasPassword":!self.password.is_null(),"gameData":self.game,"gameStarted":self.started,"joinClosed":self.closed,"rtt":rtt,"metaData":self.meta});
        if self.migration {
            v["hostGeneration"] = json!(self.generation)
        }
        if self.binary {
            v["binaryRelay"] = json!(true)
        }
        if self.persistent {
            v["persistent"] = json!(true);
            v["participants"] = json!(self.players)
        }
        v
    }
    pub fn header(&self) -> Value {
        json!({"version":1,"roomId":self.id,"name":self.name,"ownerId":self.owner,"maxPlayers":self.max,"password":self.password,"gameData":self.game,"metaData":self.meta,"startData":self.start,"players":self.players,"generation":self.generation,"binaryRelay":self.binary,"revision":self.revision,"updatedAt":self.updated,"events":self.events})
    }
}
