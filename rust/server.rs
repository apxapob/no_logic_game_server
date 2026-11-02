use crate::{config::Config, model::*, protocol, store::Store};
use anyhow::Result;
use bytes::Bytes;
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub struct Connection {
    pub udp: Option<crate::udp::Session>,
    pub udp_incoming_rate: crate::udp::Rate,
    pub udp_outgoing_rate: crate::udp::Rate,
    pub tx: mpsc::UnboundedSender<Message>,
    pub queued: Arc<AtomicUsize>,
    pub player: Option<String>,
    pub created: u64,
    pub activity: u64,
    pub ping: Option<u64>,
    pub last_ping: u64,
    pub rate_at: u64,
    pub messages: usize,
    pub delayed: usize,
    pub pending: usize,
    pub closing: AtomicBool,
    pub abort: tokio::sync::watch::Sender<bool>,
}
pub struct Delayed {
    pub at: u64,
    pub cid: u64,
    pub version: u64,
    pub scoped: bool,
    pub frame: Message,
    pub size: usize,
}
pub struct Server {
    pub diagnostics: crate::diagnostics::Diagnostics,
    pub config: Config,
    pub players: IndexMap<String, Player>,
    pub rooms: IndexMap<String, Room>,
    pub connections: IndexMap<u64, Connection>,
    pub store: Store,
    pub delayed: Vec<Delayed>,
    pub push: bool,
    pub pushes_in_flight: usize,
    pub legacy_pushes: Vec<crate::push::LegacyPush>,
    pub notice_wake: Arc<tokio::sync::Notify>,
    pub legacy_wake: Arc<tokio::sync::Notify>,
}
impl Server {
    fn frame(&self, cid: u64, direction: &str, msg: &Message) {
        if !self.diagnostics.verbose {
            return;
        }
        use base64::Engine;
        let (kind, mut payload) = match msg {
            Message::Text(s) => (
                "text",
                serde_json::from_str::<Value>(s).unwrap_or(json!("[omitted: invalid JSON]")),
            ),
            Message::Binary(b) => (
                "binary",
                json!(base64::engine::general_purpose::STANDARD.encode(b)),
            ),
            Message::Ping(b) => (
                "ping",
                json!(base64::engine::general_purpose::STANDARD.encode(b)),
            ),
            Message::Pong(b) => (
                "pong",
                json!(base64::engine::general_purpose::STANDARD.encode(b)),
            ),
            _ => return,
        };
        if kind == "text" {
            crate::diagnostics::redact(&mut payload)
        }
        self.diagnostics.event("message",json!({"connectionId":cid,"direction":direction,"type":kind,"bytes":msg.len(),"encoding":if kind=="text"{"json"}else{"base64"},"payload":payload}));
    }
    pub fn new(config: Config) -> Result<Self> {
        let store = Store::new(config.s("sessionDirectory"), config.n("sessionMaxBytes"))?;
        let diagnostics = crate::diagnostics::Diagnostics::new(&config);
        Ok(Self {
            diagnostics,
            config,
            players: IndexMap::new(),
            rooms: IndexMap::new(),
            connections: IndexMap::new(),
            store,
            delayed: vec![],
            push: std::env::var("FCM_ENABLED").as_deref() == Ok("true"),
            pushes_in_flight: 0,
            legacy_pushes: vec![],
            notice_wake: Arc::new(tokio::sync::Notify::new()),
            legacy_wake: Arc::new(tokio::sync::Notify::new()),
        })
    }
    pub fn stats(&self) -> Value {
        json!({"accounts":self.players.len(),"online":self.players.values().filter(|p|p.connection.is_some()).count(),"rooms":self.rooms.len(),"pendingConnections":self.connections.values().filter(|c|c.player.is_none()).count()})
    }
    pub fn connected(
        &mut self,
        cid: u64,
        tx: mpsc::UnboundedSender<Message>,
        queued: Arc<AtomicUsize>,
        abort: tokio::sync::watch::Sender<bool>,
    ) {
        self.diagnostics
            .event("transport.connected", json!({"connectionId":cid}));
        self.diagnostics
            .event("connection.connected", json!({"connectionId":cid}));
        let t = now();
        self.connections.insert(
            cid,
            Connection {
                udp: None,
                udp_incoming_rate: crate::udp::Rate::default(),
                udp_outgoing_rate: crate::udp::Rate::default(),
                tx,
                queued,
                player: None,
                created: t,
                activity: t,
                ping: None,
                last_ping: t,
                rate_at: t,
                messages: 0,
                delayed: 0,
                pending: 0,
                closing: AtomicBool::new(false),
                abort,
            },
        );
    }
    fn fits(&self, size: usize) -> bool {
        size <= self.config.n("maxPayloadBytes") && size + 10 <= self.config.n("maxBufferedBytes")
    }
    fn encoded(&self, v: &Value) -> Option<Message> {
        let s = protocol::stringify(v);
        self.fits(s.len()).then(|| Message::Text(s.into()))
    }
    fn raw(&self, cid: u64, msg: Message) {
        if let Some(c) = self.connections.get(&cid) {
            if c.closing.load(Ordering::Relaxed) {
                return;
            }
            if msg.is_close() {
                c.closing.store(true, Ordering::Relaxed);
            }
            let n = msg.len()
                + if msg.is_ping() || msg.is_pong() {
                    2
                } else {
                    10
                };
            if c.queued.fetch_add(n, Ordering::Relaxed) + n > self.config.n("maxBufferedBytes") {
                c.queued.fetch_sub(n, Ordering::Relaxed);
                c.closing.store(true, Ordering::Relaxed);
                self.diagnostics.event(
                    "connection.terminate",
                    json!({"connectionId":cid,"reason":"output_buffer_limit"}),
                );
                let _ = c.abort.send(true);
                return;
            }
            self.frame(cid, "out", &msg);
            if c.tx.send(msg).is_err() {
                c.queued.fetch_sub(n, Ordering::Relaxed);
            }
        }
    }
    fn send_c(&self, cid: u64, v: Value) {
        if let Some(msg)=self.encoded(&v).or_else(||self.encoded(&json!({"method":"error","data":{"code":"response_too_large","text":"response_too_large"}}))){self.raw(cid,msg)}
    }
    fn send(&self, p: &str, v: Value) {
        if let Some(cid) = self.players.get(p).and_then(|p| p.connection) {
            self.send_c(cid, v)
        }
    }
    fn bytes(&self, p: &str, b: Bytes) {
        if self.fits(b.len())
            && let Some(cid) = self.players.get(p).and_then(|p| p.connection)
        {
            self.raw(cid, Message::Binary(b))
        }
    }
    fn error(&self, cid: u64, code: &str) {
        self.diagnostics
            .event("protocol.error", json!({"connectionId":cid,"code":code}));
        self.send_c(
            cid,
            json!({"method":"error","data":{"code":code,"text":code}}),
        )
    }
    fn err(&self, p: &str, code: &str) {
        self.diagnostics
            .event("protocol.error", json!({"playerId":p,"code":code}));
        self.send(
            p,
            json!({"method":"error","data":{"code":code,"text":code}}),
        )
    }
    fn close(&self, cid: u64, code: u16, reason: &str) {
        use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
        self.raw(
            cid,
            Message::Close(Some(CloseFrame {
                code: CloseCode::from(code),
                reason: reason.to_owned().into(),
            })),
        )
    }
    fn broadcast(&self, r: &Room, v: Value, except: Option<&str>, targets: Option<&Value>) {
        if let Some(msg) = self.encoded(&v) {
            self.broadcast_frame(r, msg, except, targets);
        }
    }
    fn broadcast_frame(
        &self,
        r: &Room,
        msg: Message,
        except: Option<&str>,
        targets: Option<&Value>,
    ) {
        for id in &r.active {
            if except == Some(id.as_str())
                || targets.is_some_and(|a| !a.as_array().is_some_and(|a| a.contains(&json!(id))))
            {
                continue;
            }
            if let Some(c) = self
                .players
                .get(id)
                .filter(|p| p.room.as_deref() == Some(&r.id))
                .and_then(|p| p.connection)
            {
                self.raw(c, msg.clone());
            }
        }
    }
    fn lobby(&self, v: Value) {
        if let Some(msg) = self.encoded(&v) {
            for p in self.players.values().filter(|p| p.room.is_none()) {
                if let Some(c) = p.connection {
                    self.raw(c, msg.clone())
                }
            }
        }
    }
    fn dto(&self, r: &Room) -> Value {
        r.dto(self.players.get(&r.owner).and_then(|p| p.rtt))
    }
    fn room_fits(&self, r: &Room) -> bool {
        if !self.fits(r.max.saturating_mul(r.owner.len() + 3) + 1) {
            return false;
        }
        let mut dto = self.dto(r);
        dto["players"] = json!(vec![&r.owner; r.max]);
        dto["rtt"] = json!(9007199254740991u64);
        dto["gameStarted"] = json!(false);
        self.encoded(&json!({"method":"onGetRooms","data":[dto],"nextCursor":r.id}))
            .is_some()
    }
    fn relay(&self, p: &str, v: &Value) -> Option<Message> {
        let encoded = self.encoded(v);
        if encoded.is_none() {
            self.err(p, "payload_too_large");
        }
        encoded
    }
    pub fn disconnect(&mut self, cid: u64) {
        if !self.connections.contains_key(&cid) {
            return;
        }
        self.diagnostics
            .event("connection.disconnected", json!({"connectionId":cid}));
        self.delayed.retain(|d| d.cid != cid);
        if let Some(c) = self.connections.shift_remove(&cid)
            && let Some(id) = c.player
            && self
                .players
                .get(&id)
                .is_some_and(|p| p.connection == Some(cid))
        {
            let p = self.players.get_mut(&id).unwrap();
            p.connection = None;
            p.offline = Some(now());
            let _ = self.leave(&id, true);
        }
    }
    fn expire(&mut self) {
        let t = now();
        let ids: Vec<_> = self
            .players
            .values()
            .filter(|p| {
                p.connection.is_none()
                    && p.offline.is_some_and(|at| {
                        t.saturating_sub(at) >= self.config.n("accountTtlMs") as u64
                    })
                    && !self
                        .rooms
                        .values()
                        .any(|r| r.fixed && r.players.contains(&p.id))
            })
            .map(|p| p.id.clone())
            .collect();
        for id in ids {
            self.players.shift_remove(&id);
            self.diagnostics
                .event("account.expired", json!({"playerId":id}));
            for r in self.rooms.values_mut() {
                r.reservations.shift_remove(&id);
            }
        }
    }
    fn auth(&mut self, cid: u64, d: &Value) -> Result<()> {
        use subtle::ConstantTimeEq;
        self.expire();
        let created = d.get("playerId").is_none() && d.get("password").is_none();
        let id;
        if !created {
            let key = d["playerId"].as_str().unwrap_or("");
            let retained = if let Some(p) = self.players.get(key) {
                Some(p.clone())
            } else if protocol::uuid(&json!(key)) {
                self.store.account(key)?
            } else {
                None
            };
            let Some(mut p) = retained else {
                self.diagnostics
                    .event("authentication.failed", json!({"connectionId":cid}));
                self.send_c(cid, json!({"method":"wrongPassword"}));
                self.close(cid, 1008, "Authentication failed");
                return Ok(());
            };
            if !bool::from(
                p.password
                    .as_bytes()
                    .ct_eq(d["password"].as_str().unwrap_or("").as_bytes()),
            ) {
                self.diagnostics
                    .event("authentication.failed", json!({"connectionId":cid}));
                self.send_c(cid, json!({"method":"wrongPassword"}));
                self.close(cid, 1008, "Authentication failed");
                return Ok(());
            }
            id = p.id.clone();
            if !self.players.contains_key(&id) {
                self.players.insert(id.clone(), p.clone());
            }
            if p.room
                .as_ref()
                .and_then(|r| self.rooms.get(r))
                .is_some_and(|r| r.started && r.fixed)
            {
                self.leave(&id, true)?;
                p = self.players[&id].clone();
            }
            if let Some(old) = p.connection {
                self.diagnostics.event(
                    "connection.terminate",
                    json!({"reason":"session_replaced","connectionId":old}),
                );
                self.close(old, 1008, "Session replaced");
                self.delayed.retain(|d| d.cid != old);
            }
            if let Some(n) = d["name"].as_str() {
                p.name = n.into()
            }
            self.players.insert(id.clone(), p);
        } else {
            if self.players.len() >= self.config.n("maxAccounts") {
                self.error(cid, "limit_exceeded");
                self.close(cid, 1008, "Account limit");
                return Ok(());
            }
            let p = Player::new(d["name"].as_str().unwrap_or("Player").into());
            id = p.id.clone();
            self.players.insert(id.clone(), p);
        }
        let p = self.players.get_mut(&id).unwrap();
        p.connection = Some(cid);
        p.offline = None;
        p.rtt = None;
        self.connections.get_mut(&cid).unwrap().player = Some(id.clone());
        self.store.save_account(p)?;
        self.diagnostics.event(
            "authentication.succeeded",
            json!({"connectionId":cid,"playerId":id,"created":created}),
        );
        let account = json!({"method":"accountCreated","data":{"name":p.name,"playerId":id,"password":p.password}});
        if created {
            self.send_c(cid, account);
        }
        let mut data =
            json!({"online":self.players.values().filter(|p|p.connection.is_some()).count()});
        if self.store.enabled {
            data["persistentSessions"] = json!(true)
        }
        if self.push {
            data["pushNotifications"] = json!(true)
        }
        if self.config.b("udpEnabled") {
            data["udpRelay"] = json!({"version":1,"port":self.config.n("udpPort"),"maxDatagramBytes":self.config.n("udpMaxDatagramBytes"),"maxPayloadBytes":self.config.n("udpMaxDatagramBytes")-69,"endpointTtlMs":self.config.n("udpEndpointTtlMs"),"challengeTtlMs":self.config.n("udpChallengeTtlMs"),"incomingPacketsPerSecond":self.config.n("udpIncomingPacketsPerSecond"),"outgoingPacketsPerSecond":self.config.n("udpOutgoingPacketsPerSecond")});
        }
        self.send_c(cid, json!({"method":"onConnected","data":data}));
        if let Some(r) = self.players[&id]
            .room
            .as_ref()
            .and_then(|id| self.rooms.get(id))
        {
            self.send_c(cid, json!({"method":"onRoomEnter","data":self.dto(r)}))
        }
        Ok(())
    }
    fn enter(&mut self, p: &str, id: &str, password: &Value) -> Result<()> {
        if let Some(room) = &self.players[p].room {
            self.err(
                p,
                if room == id {
                    "already_in_room"
                } else {
                    "in_other_room"
                },
            );
            return Ok(());
        }
        let loaded = if self.rooms.contains_key(id) {
            None
        } else {
            self.store.load(id, true)?
        };
        if let Some(r) = loaded {
            self.rooms.insert(id.into(), r);
        }
        let Some(r) = self.rooms.get(id) else {
            self.err(p, "no_room");
            return Ok(());
        };
        let error = if !r.started && r.closed {
            Some("room_closed")
        } else if r.started && !r.rejoin(p) {
            Some("game_started_without_you")
        } else if !r.started && password != &r.password {
            Some("wrong_password")
        } else if r.active.len() >= r.max {
            Some("full_room")
        } else {
            None
        };
        if let Some(e) = error {
            self.err(p, e);
            if self.rooms[id].active.is_empty() && self.rooms[id].persistent {
                self.rooms.shift_remove(id);
            }
            return Ok(());
        }
        let r = self.rooms.get_mut(id).unwrap();
        if r.persistent && r.active.is_empty() {
            r.owner = p.into();
            r.generation += 1;
            r.upload = None
        }
        r.active.insert(p.into());
        r.reservations.shift_remove(p);
        let player = self.players.get_mut(p).unwrap();
        player.room = Some(id.into());
        player.entered = Some(now());
        player.version += 1;
        let dto = player.dto();
        self.diagnostics
            .event("room.entered", json!({"roomId":id,"playerId":p}));
        let r = &self.rooms[id];
        self.broadcast(r, json!({"method":"playerEnter","data":dto}), Some(p), None);
        self.send(p, json!({"method":"onRoomEnter","data":self.dto(r)}));
        Ok(())
    }
    fn keep(&mut self, r: Room) {
        if r.persistent && r.active.is_empty() && self.store.save(&r).is_ok() {
            let active = self.rooms.keys().cloned().collect();
            if let Ok(ids) = self.store.prune(&active) {
                for id in ids {
                    self.lobby(json!({"method":"roomDeleted","data":id}));
                }
            }
            return;
        }
        self.rooms.insert(r.id.clone(), r);
    }
    fn leave(&mut self, p: &str, disconnected: bool) -> Result<()> {
        let player = self.players.get_mut(p).unwrap();
        let id = player.room.take();
        player.entered = None;
        player.version += 1;
        if !disconnected {
            for r in self.rooms.values_mut() {
                r.reservations.shift_remove(p);
            }
        }
        let Some(mut r) = id.and_then(|id| self.rooms.shift_remove(&id)) else {
            return Ok(());
        };
        self.diagnostics
            .event("room.left", json!({"roomId":r.id,"playerId":p}));
        r.active.shift_remove(p);
        if r.upload.as_ref().is_some_and(|u| u.owner == p) {
            r.upload = None
        }
        if disconnected && r.started {
            r.reservations.insert(p.into());
        } else {
            r.reservations.shift_remove(p);
        }
        self.broadcast(
            &r,
            json!({"method":if disconnected{"playerDisconnected"}else{"playerLeft"},"data":p}),
            None,
            None,
        );
        if r.started && r.fixed && !r.migration && r.owner == p {
            for id in &r.active {
                if let Some(p) = self.players.get_mut(id) {
                    p.room = None;
                    p.entered = None;
                    p.version += 1
                }
            }
            r.active.clear();
        }
        if r.active.is_empty() {
            if r.persistent {
                self.keep(r)
            } else {
                self.diagnostics
                    .event("room.deleted", json!({"roomId":r.id}));
                self.lobby(json!({"method":"roomDeleted","data":r.id}))
            }
            return Ok(());
        }
        if r.owner == p {
            r.owner = r.active.first().unwrap().clone();
            r.generation += 1;
            self.diagnostics.event(
                "room.owner_changed",
                json!({"roomId":r.id,"ownerId":r.owner}),
            );
            self.broadcast(&r,json!({"method":"newRoomOwner","data":if r.migration{json!({"playerId":r.owner,"generation":r.generation})}else{json!(r.owner)}}),None,None);
        }
        if r.started && r.fixed {
            for id in &r.players {
                if self.players.get(id).is_some_and(|p| p.room.is_none()) {
                    self.send(id, json!({"method":"roomCreated","data":self.dto(&r)}));
                }
            }
        }
        self.rooms.insert(r.id.clone(), r);
        Ok(())
    }
    pub fn receive(&mut self, cid: u64, frame: Message) {
        self.frame(cid, "in", &frame);
        let Some(c) = self.connections.get_mut(&cid) else {
            return;
        };
        if c.closing.load(Ordering::Relaxed) {
            return;
        }
        if c.player.as_ref().is_some_and(|id| {
            self.players
                .get(id)
                .is_none_or(|p| p.connection != Some(cid))
        }) {
            return;
        }
        let t = now();
        if t.saturating_sub(c.rate_at) >= 1000 {
            c.rate_at = t;
            c.messages = 0
        }
        c.messages += 1;
        c.activity = t;
        if c.messages > self.config.n("maxMessagesPerSecond") {
            self.diagnostics.event(
                "connection.terminate",
                json!({"reason":"message_rate_limit"}),
            );
            self.close(cid, 1008, "Message rate limit");
            return;
        }
        match &frame {
            Message::Ping(b) => {
                self.raw(cid, Message::Pong(b.clone()));
                return;
            }
            Message::Pong(_) => return,
            _ => {}
        }
        let player = self.connections[&cid].player.clone();
        if frame.len() > self.config.n("maxPayloadBytes") {
            self.close(cid, 1009, "Message too large");
            return;
        }
        let mut scoped = true;
        let mut immediate = false;
        let mut parsed = None;
        if let Message::Text(text) = &frame {
            let Ok(v) = protocol::parse(text) else {
                self.error(cid, "invalid_message");
                return;
            };
            if !protocol::validate(
                &v,
                self.config.n("maxRoomPlayers"),
                self.config.n("maxAccounts"),
            ) {
                self.error(cid, "invalid_message");
                return;
            }
            if protocol::stringify(&v).len() > self.config.n("maxPayloadBytes") {
                self.error(cid, "payload_too_large");
                return;
            }
            let method = v["method"].as_str().unwrap();
            if player.is_none() {
                if method == "authenticate" {
                    if self.auth(cid, &v["data"]).is_err() {
                        self.error(cid, "storage_error")
                    }
                } else {
                    self.error(cid, "invalid_message")
                }
                return;
            }
            if method == "authenticate" {
                self.error(cid, "invalid_message");
                return;
            }
            immediate = method == "Pong";
            scoped = ![
                "getRooms",
                "getSavedRooms",
                "getPlayers",
                "changeName",
                "createRoom",
                "enterRoom",
                "leaveRoom",
                "setPushDevice",
            ]
            .contains(&method);
            parsed = Some(v);
        } else if player.is_none() {
            self.error(cid, "invalid_message");
            return;
        } else if !self.fits(frame.len()) {
            self.error(cid, "payload_too_large");
            return;
        }
        let delay = self.config.n("sendDelayMs");
        if delay > 0 && !immediate {
            let c = self.connections.get_mut(&cid).unwrap();
            if c.delayed + frame.len() > self.config.n("maxBufferedBytes")
                || c.pending >= self.config.n("maxMessagesPerSecond")
            {
                self.close(cid, 1008, "Delay limit");
                return;
            }
            c.delayed += frame.len();
            c.pending += 1;
            self.delayed.push(Delayed {
                at: t + delay as u64,
                cid,
                version: self.players[player.as_ref().unwrap()].version,
                scoped,
                size: frame.len(),
                frame,
            });
        } else {
            self.dispatch(cid, frame, parsed)
        }
    }
    fn dispatch(&mut self, cid: u64, frame: Message, parsed: Option<Value>) {
        let Some(p) = self.connections.get(&cid).and_then(|c| c.player.clone()) else {
            return;
        };
        let result = match frame {
            // Immediate traffic reuses the validated JSON. Delayed traffic keeps
            // only its bounded wire bytes and parses them when the delay expires.
            Message::Text(s) => self.handle(
                cid,
                &p,
                &parsed.unwrap_or_else(|| protocol::parse(&s).unwrap()),
            ),
            Message::Binary(b) => self.binary(&p, b),
            _ => Ok(()),
        };
        if result.is_err() {
            self.error(cid, "storage_error")
        }
    }
    fn binary(&mut self, p: &str, bytes: Bytes) -> Result<()> {
        let Some(id) = self.players[p].room.as_ref() else {
            return Ok(());
        };
        let Some(room) = self.rooms.get(id) else {
            return Ok(());
        };
        if room.persistent && bytes.first() == Some(&2) {
            let id = id.clone();
            let mut room = self.rooms.swap_remove(&id).unwrap();
            self.upload(p, &mut room, &bytes);
            self.rooms.insert(id, room);
            return Ok(());
        }
        if !room.binary {
            for id in &room.active {
                if id != p {
                    self.bytes(id, bytes.clone());
                }
            }
            return Ok(());
        }
        if bytes.len() < 18 || bytes[0] != 1 {
            self.err(p, "invalid_message");
            return Ok(());
        }
        let address = uuid::Uuid::from_slice(&bytes[1..17]).unwrap();
        let broadcast = address.is_nil();
        if !broadcast && (!(1..=8).contains(&(bytes[7] >> 4)) || bytes[9] & 0xc0 != 0x80) {
            self.err(p, "invalid_message");
            return Ok(());
        }
        let target = if broadcast {
            None
        } else {
            Some(address.to_string())
        };
        let mut out = match bytes.try_into_mut() {
            Ok(b) => b,
            Err(b) => bytes::BytesMut::from(b.as_ref()),
        };
        out[1..17].copy_from_slice(uuid::Uuid::parse_str(p).unwrap().as_bytes());
        let out = out.freeze();
        for id in &room.active {
            if id != p && target.as_ref().is_none_or(|target| target == id) {
                self.bytes(id, out.clone());
            }
        }
        Ok(())
    }
    fn reply(&self, p: &str, request: &Value, mut data: Value) {
        data["requestId"] = request.clone();
        self.send(p, json!({"method":"sessionReply","data":data}))
    }
    fn upload(&self, p: &str, r: &mut Room, b: &[u8]) {
        if b.len() < 22 {
            return;
        }
        let Some(u) = r.upload.as_mut() else { return };
        if uuid::Uuid::parse_str(&u.id).unwrap().as_bytes() != &b[1..17]
            || u.owner != p
            || r.owner != p
            || u.generation != r.generation
            || u32::from_be_bytes(b[17..21].try_into().unwrap()) as usize != u.offset
            || u.offset + b.len() - 21 > u.bytes.len()
        {
            self.reply(p, &json!(u.id), json!({"error":"stale_session"}));
            r.upload = None;
            return;
        }
        u.bytes[u.offset..u.offset + b.len() - 21].copy_from_slice(&b[21..]);
        u.offset += b.len() - 21;
        u.at = now();
        self.reply(p, &json!(u.id), json!({"offset":u.offset}));
    }
    fn session(&mut self, p: &str, r: &mut Room, m: &str, d: &Value) -> Result<()> {
        let req = &d["requestId"];
        if !r.persistent {
            self.reply(p, req, json!({"error":"unavailable"}));
            return Ok(());
        }
        if m == "getSession" {
            self.reply(p,req,json!({"revision":r.revision,"generation":r.generation,"size":r.state.len(),"startData":r.start}));
            return Ok(());
        }
        if m == "getSessionChunk" {
            let off = d["offset"].as_u64().unwrap() as usize;
            if d["revision"] != r.revision || off >= r.state.len() {
                self.reply(p, req, json!({"error":"stale_session"}));
                return Ok(());
            }
            let n = 32000
                .min(self.config.n("maxPayloadBytes").saturating_sub(21))
                .min(self.config.n("maxBufferedBytes").saturating_sub(31))
                .min(r.state.len() - off);
            let mut b = Vec::with_capacity(21 + n);
            b.push(3);
            b.extend_from_slice(
                uuid::Uuid::parse_str(req.as_str().unwrap())
                    .unwrap()
                    .as_bytes(),
            );
            b.extend_from_slice(&(off as u32).to_be_bytes());
            b.extend_from_slice(&r.state[off..off + n]);
            self.bytes(p, b.into());
            return Ok(());
        }
        if r.owner != p {
            self.reply(p, req, json!({"error":"not_room_owner"}));
            return Ok(());
        }
        if m == "beginSession" {
            if d["revision"] != r.revision || d["generation"] != r.generation {
                self.reply(p, req, json!({"error":"stale_session"}));
                return Ok(());
            }
            let size = d["size"].as_u64().unwrap();
            if size > self.config.n("maxSessionBytes") as u64 {
                self.reply(p, req, json!({"error":"payload_too_large"}));
                return Ok(());
            }
            r.upload = Some(Upload {
                id: req.as_str().unwrap().into(),
                owner: p.into(),
                generation: r.generation,
                revision: r.revision,
                bytes: vec![0; size as usize],
                offset: 0,
                at: now(),
            });
            self.reply(p, req, json!({"offset":0}));
            return Ok(());
        }
        if !r.upload.as_ref().is_some_and(|u| {
            json!(u.id) == *req
                && u.owner == p
                && u.generation == r.generation
                && u.revision == r.revision
                && u.offset == u.bytes.len()
        }) {
            self.reply(p, req, json!({"error":"stale_session"}));
            return Ok(());
        }
        if [&d["scheduled"], &d["immediate"]].iter().any(|n| {
            n["to"]
                .as_array()
                .is_some_and(|a| a.iter().any(|id| !r.players.contains(id.as_str().unwrap())))
        }) {
            self.reply(p, req, json!({"error":"invalid_message"}));
            return Ok(());
        }
        if self
            .store
            .commit(r, &d["scheduled"], &d["immediate"])
            .is_err()
        {
            self.reply(p, req, json!({"error":"storage_error"}));
            return Ok(());
        }
        if let Some(e) = d["immediate"]["eventId"].as_str() {
            r.events.insert(e.into());
            if r.events.len() > 128 {
                r.events.shift_remove_index(0);
            }
        }
        r.state = r.upload.take().unwrap().bytes.into();
        r.revision += 1;
        r.updated = now();
        self.notice_wake.notify_one();
        self.reply(p, req, json!({"revision":r.revision}));
        self.broadcast(
            r,
            json!({"method":"sessionUpdated","data":{"revision":r.revision}}),
            Some(p),
            None,
        );
        Ok(())
    }
    fn handle(&mut self, cid: u64, p: &str, v: &Value) -> Result<()> {
        let m = v["method"].as_str().unwrap();
        let d = &v["data"];
        match m {
            "openUdp" => {
                if !self.config.b("udpEnabled") {
                    self.err(p, "udp_disabled");
                } else if self.players[p].room.is_none() {
                    self.err(p, "no_room");
                } else {
                    let session = crate::udp::Session::new(self.players[p].version);
                    use base64::Engine;
                    let secret = base64::engine::general_purpose::STANDARD.encode(session.secret);
                    self.connections.get_mut(&cid).unwrap().udp = Some(session);
                    self.send_c(cid, json!({"method":"udpSession","data":{"connectionId":cid.to_string(),"secret":secret,"port":self.config.n("udpPort"),"version":1,"maxDatagramBytes":self.config.n("udpMaxDatagramBytes"),"maxPayloadBytes":self.config.n("udpMaxDatagramBytes")-69,"endpointTtlMs":self.config.n("udpEndpointTtlMs"),"challengeTtlMs":self.config.n("udpChallengeTtlMs"),"incomingPacketsPerSecond":self.config.n("udpIncomingPacketsPerSecond"),"outgoingPacketsPerSecond":self.config.n("udpOutgoingPacketsPerSecond")}}));
                }
                return Ok(());
            }
            "closeUdp" => {
                self.connections.get_mut(&cid).unwrap().udp = None;
                self.send_c(cid, json!({"method":"udpClosed","data":null}));
                return Ok(());
            }
            "Pong" => {
                let c = self.connections.get_mut(&cid).unwrap();
                if c.ping.is_some_and(|t| *d == json!(t)) {
                    self.players.get_mut(p).unwrap().rtt =
                        Some(now().saturating_sub(c.ping.take().unwrap()));
                }
                return Ok(());
            }
            "getRooms" => {
                let after = d["after"].as_str().unwrap_or("").to_lowercase();
                let mut rooms: Vec<_> = self
                    .rooms
                    .values()
                    .filter(|r| r.id > after && (!r.started || r.active.contains(p) || r.rejoin(p)))
                    .collect();
                rooms.sort_by(|a, b| a.id.cmp(&b.id));
                let mut data = vec![];
                let mut cursor = Value::Null;
                for (i, r) in rooms.iter().enumerate() {
                    let next = if i + 1 < rooms.len() {
                        json!(r.id)
                    } else {
                        Value::Null
                    };
                    data.push(self.dto(r));
                    if self
                        .encoded(&json!({"method":"onGetRooms","data":data,"nextCursor":next}))
                        .is_none()
                    {
                        data.pop();
                        if data.is_empty() {
                            self.err(p, "response_too_large");
                            return Ok(());
                        }
                        break;
                    }
                    cursor = next;
                }
                self.send(
                    p,
                    json!({"method":"onGetRooms","data":data,"nextCursor":cursor}),
                );
                return Ok(());
            }
            "getSavedRooms" => {
                for id in d["ids"].as_array().unwrap() {
                    let key = id.as_str().unwrap();
                    let loaded = if self.rooms.contains_key(key) {
                        None
                    } else {
                        self.store.load(key, false)?
                    };
                    let room = self
                        .rooms
                        .get(key)
                        .or(loaded.as_ref())
                        .filter(|r| r.persistent && r.players.contains(p))
                        .map(|r| self.dto(r));
                    self.send(
                        p,
                        json!({"method":"savedRoom","data":{"roomId":id,"room":room}}),
                    );
                }
                return Ok(());
            }
            "getPlayers" => {
                let mut selected = vec![];
                if let Some(ids) = d.as_array() {
                    for id in ids {
                        let id = id.as_str().unwrap();
                        if let Some(p) = self.players.get(id) {
                            selected.push(p.clone())
                        } else if let Some(p) = self.store.account(id)? {
                            selected.push(p)
                        }
                    }
                } else {
                    selected.extend(
                        self.players
                            .values()
                            .filter(|p| p.connection.is_some())
                            .cloned(),
                    )
                }
                selected.sort_by(|a, b| {
                    a.entered
                        .unwrap_or(u64::MAX)
                        .cmp(&b.entered.unwrap_or(u64::MAX))
                        .then(a.id.cmp(&b.id))
                });
                self.send(p,json!({"method":"onGetPlayers","data":selected.iter().map(Player::dto).collect::<Vec<_>>()}));
                return Ok(());
            }
            "changeName" => {
                let player = self.players.get_mut(p).unwrap();
                player.name = d.as_str().unwrap().into();
                self.store.save_account(player)?;
                if let Some(r) = self.players[p]
                    .room
                    .as_ref()
                    .and_then(|id| self.rooms.get(id))
                {
                    self.broadcast(
                        r,
                        json!({"method":"nameChanged","data":{"name":d,"playerId":p}}),
                        None,
                        None,
                    )
                }
                return Ok(());
            }
            "enterRoom" => return self.enter(p, d["roomId"].as_str().unwrap(), &d["password"]),
            "leaveRoom" => return self.leave(p, false),
            "setPushDevice" => {
                if !self.push {
                    self.err(p, "push_unavailable");
                    return Ok(());
                }
                let device = d["deviceId"].as_str().unwrap();
                if d["token"].is_null() {
                    self.players
                        .get_mut(p)
                        .unwrap()
                        .devices
                        .shift_remove(device);
                } else {
                    for a in self.players.values_mut() {
                        a.devices
                            .retain(|id, v| v["token"] != d["token"] || (a.id == p && id == device))
                    }
                    let a = self.players.get_mut(p).unwrap();
                    if !a.devices.contains_key(device) && a.devices.len() >= 4 {
                        a.devices.shift_remove_index(0);
                    }
                    a.devices.insert(device.into(),json!({"token":d["token"],"foreground":d["foreground"],"language":d["language"].as_str().unwrap_or("en")}));
                }
                self.store.save_account(&self.players[p])?;
                self.send(p, json!({"method":"pushDeviceUpdated"}));
                return Ok(());
            }
            "getModerationTicket" => {
                use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
                use hmac::{Hmac, Mac};
                use sha2::Sha256;
                let req = &d["requestId"];
                let target = d["target"].as_str().unwrap();
                let room_id = d["room"].as_str().unwrap();
                let allowed = self.rooms.get(room_id).is_some_and(|r| {
                    target != p
                        && (r.owner == target
                            || (r.players.contains(p) && r.players.contains(target)))
                });
                let key = self.config.s("moderationSigningKey");
                if key.is_empty() || !allowed {
                    self.reply(p, req, json!({"error":"moderation_unavailable"}));
                    return Ok(());
                }
                let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({
                    "reporter":p,"target":target,"room":room_id,"expires":now()+300000,
                    "purpose":"profile-report-v1"
                }))?);
                let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
                mac.update(payload.as_bytes());
                let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
                self.reply(p, req, json!({"ticket":format!("{payload}.{signature}")}));
                return Ok(());
            }
            "createRoom" => {
                if self.players[p].room.is_some() {
                    self.err(p, "in_other_room");
                    return Ok(());
                }
                if self.rooms.len() >= self.config.n("maxRooms") {
                    self.err(p, "limit_exceeded");
                    return Ok(());
                }
                let mut r = Room::new(
                    d["name"].as_str().unwrap().into(),
                    p.into(),
                    d["maxPlayers"].as_u64().unwrap() as usize,
                    d["password"].clone(),
                    d["gameData"].clone(),
                );
                r.binary = d["binaryRelay"] == true;
                if !self.room_fits(&r) {
                    self.err(p, "payload_too_large");
                    return Ok(());
                }
                let id = r.id.clone();
                self.diagnostics.event("room.created", json!({"roomId":id}));
                self.rooms.insert(id.clone(), r);
                self.enter(p, &id, &d["password"])?;
                self.lobby(json!({"method":"roomCreated","data":self.dto(&self.rooms[&id])}));
                return Ok(());
            }
            _ => {}
        }
        let Some(id) = self.players[p].room.clone() else {
            self.err(p, "no_room");
            return Ok(());
        };
        // Room listing is sorted by ID; only membership order selects the next
        // owner. Avoid shifting every other room for each JSON relay message.
        let Some(mut r) = self.rooms.swap_remove(&id) else {
            self.err(p, "no_room");
            return Ok(());
        };
        let result = self.room_message(p, &mut r, m, d);
        self.rooms.insert(id, r);
        result
    }
    fn room_message(&mut self, p: &str, r: &mut Room, m: &str, d: &Value) -> Result<()> {
        if [
            "getSession",
            "getSessionChunk",
            "beginSession",
            "commitSession",
        ]
        .contains(&m)
        {
            return self.session(p, r, m, d);
        }
        match m {
            "notifyPlayers" => {
                if !self.push {
                    self.err(p, "push_unavailable");
                    return Ok(());
                }
                if r.owner != p {
                    self.err(p, "not_room_owner");
                    return Ok(());
                }
                if !r.started
                    || !r.fixed
                    || d["to"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|id| !r.players.contains(id.as_str().unwrap()))
                {
                    self.err(p, "invalid_message");
                    return Ok(());
                }
                let event = d["eventId"].as_str().unwrap();
                if r.events.contains(event) {
                    return Ok(());
                }
                if now().saturating_sub(r.last_push) < 30000 || self.pushes_in_flight >= 32 {
                    self.err(p, "push_rate_limited");
                    return Ok(());
                }
                r.last_push = now();
                r.events.insert(event.into());
                if r.events.len() > 128 {
                    r.events.shift_remove_index(0);
                }
                for target in d["to"].as_array().unwrap() {
                    let id = target.as_str().unwrap();
                    if id == p {
                        continue;
                    }
                    let Some(player) = self.players.get(id) else {
                        continue;
                    };
                    for (device_id, device) in &player.devices {
                        if self.pushes_in_flight >= 32
                            || (player.connection.is_some() && device["foreground"] == true)
                        {
                            continue;
                        }
                        let translated =
                            &d["translations"][device["language"].as_str().unwrap_or("en")];
                        let text = if translated.is_object() {
                            translated
                        } else {
                            d
                        };
                        self.legacy_pushes.push(crate::push::LegacyPush{
                            player:id.into(),device:device_id.clone(),token:device["token"].as_str().unwrap().into(),
                            notice:json!({"title":text["title"],"body":text["body"],"roomId":r.id,"eventId":event}),
                        });
                        self.pushes_in_flight += 1;
                    }
                }
                self.legacy_wake.notify_one();
            }
            "updateRoom" => {
                if r.owner != p {
                    self.err(p, "not_room_owner");
                    return Ok(());
                }
                if r.started {
                    self.err(p, "already_started");
                    return Ok(());
                }
                let max = d["maxPlayers"]
                    .as_u64()
                    .map(|n| n as usize)
                    .unwrap_or(r.max);
                if max < r.active.len() {
                    self.err(p, "room_too_small");
                    return Ok(());
                }
                let previous = (r.max, r.name.clone(), r.password.clone());
                r.max = max;
                if let Some(s) = d["name"].as_str() {
                    r.name = s.into()
                }
                if let Some(pass) = d.get("password") {
                    r.password = if pass.as_str().is_some_and(|s| !s.is_empty()) {
                        pass.clone()
                    } else {
                        Value::Null
                    }
                }
                if !self.room_fits(r) {
                    (r.max, r.name, r.password) = previous;
                    self.err(p, "payload_too_large");
                    return Ok(());
                }
                if let Some(b) = d["joinClosed"].as_bool() {
                    r.closed = b
                }
                self.diagnostics.event(
                    "room.settings_changed",
                    json!({"roomId":r.id,"ownerId":p,"maxPlayers":r.max}),
                );
                let msg = json!({"method":"roomUpdated","data":self.dto(r)});
                self.broadcast(r, msg.clone(), None, None);
                self.lobby(msg);
            }
            "sendChatMsg" | "sendToRoom" | "sendTo" => {
                let out = if m == "sendChatMsg" {
                    json!({"method":"chatMsg","data":{"text":d,"from":p}})
                } else {
                    json!({"method":"messageFromPlayer","data":{"from":p,"msg":if m=="sendTo"{&d["msg"]}else{d}}})
                };
                if let Some(out) = self.relay(p, &out) {
                    self.broadcast_frame(
                        r,
                        out,
                        if m == "sendToRoom" { Some(p) } else { None },
                        if m == "sendTo" { d.get("to") } else { None },
                    )
                }
            }
            "requestGameState" => {
                if r.active.contains(&r.owner) {
                    self.send(
                        &r.owner,
                        json!({"method":"gameStateRequested","data":self.players[p].dto()}),
                    );
                }
            }
            "startGame" | "shareGameState" | "setRoomMeta" => {
                if r.owner != p {
                    self.err(p, "not_room_owner");
                    return Ok(());
                }
                if m == "startGame" {
                    if r.started {
                        self.err(p, "already_started");
                        return Ok(());
                    }
                    let out = json!({"method":"gameStarted","data":d});
                    let Some(out) = self.relay(p, &out) else {
                        return Ok(());
                    };
                    r.fixed = d["fixedRoster"] == true;
                    r.migration = r.fixed && d["hostMigration"] == true;
                    r.persistent = self.store.enabled && r.migration && d["persistent"] == true;
                    r.start = if r.persistent { d.clone() } else { Value::Null };
                    r.updated = now();
                    if r.fixed {
                        r.players = r.active.clone()
                    }
                    r.started = true;
                    self.diagnostics
                        .event("room.game_started", json!({"roomId":r.id,"ownerId":p}));
                    self.broadcast_frame(r, out, None, None);
                    self.lobby(json!({"method":"roomBlock","data":r.id}));
                } else if m == "shareGameState" {
                    let out = json!({"method":"newGameState","data":d["gamestate"]});
                    if let Some(out) = self.relay(p, &out) {
                        self.broadcast_frame(
                            r,
                            out,
                            if d.get("to").is_some() { None } else { Some(p) },
                            d.get("to"),
                        )
                    }
                } else {
                    let old = std::mem::replace(&mut r.meta, d.clone());
                    if !self.room_fits(r) {
                        r.meta = old;
                        self.err(p, "payload_too_large");
                        return Ok(());
                    }
                    let out = json!({"method":"onSetRoomMeta","data":d});
                    if let Some(out) = self.relay(p, &out) {
                        self.broadcast_frame(r, out, None, None)
                    } else {
                        r.meta = old
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn sweep(&mut self) {
        let t = now();
        let mut pending = std::mem::take(&mut self.delayed);
        for d in pending.drain(..) {
            if d.at > t {
                self.delayed.push(d);
                continue;
            }
            let Some(c) = self.connections.get_mut(&d.cid) else {
                continue;
            };
            c.delayed = c.delayed.saturating_sub(d.size);
            c.pending = c.pending.saturating_sub(1);
            if c.player
                .as_ref()
                .and_then(|id| self.players.get(id))
                .is_some_and(|p| {
                    !c.closing.load(Ordering::Relaxed)
                        && p.connection == Some(d.cid)
                        && (!d.scoped || p.version == d.version)
                })
            {
                self.dispatch(d.cid, d.frame, None)
            } else {
                self.diagnostics.event(
                    "message.discarded",
                    json!({"reason":"session_or_room_changed","bytes":d.size}),
                );
            }
        }
        let empty: Vec<_> = self
            .rooms
            .values_mut()
            .filter_map(|r| {
                if r.upload
                    .as_ref()
                    .is_some_and(|u| t.saturating_sub(u.at) > 30000)
                {
                    r.upload = None
                }
                if r.persistent && r.active.is_empty() {
                    Some(r.id.clone())
                } else {
                    None
                }
            })
            .collect();
        for id in empty {
            let r = self.rooms.shift_remove(&id).unwrap();
            self.keep(r)
        }
        let mut heartbeat = false;
        let ids: Vec<_> = self.connections.keys().copied().collect();
        for cid in ids {
            let c = self.connections.get_mut(&cid).unwrap();
            if c.player.is_none() {
                if t.saturating_sub(c.created) >= self.config.n("authTimeoutMs") as u64 {
                    self.diagnostics.event(
                        "connection.terminate",
                        json!({"reason":"authentication_timeout"}),
                    );
                    self.close(cid, 1008, "Authentication timeout")
                }
                continue;
            }
            if t.saturating_sub(c.activity) >= self.config.n("idleTimeoutMs") as u64
                || c.ping
                    .is_some_and(|at| t.saturating_sub(at) >= self.config.n("idleTimeoutMs") as u64)
            {
                self.close(cid, 1008, "Idle timeout");
                continue;
            }
            if t.saturating_sub(c.last_ping) >= self.config.n("heartbeatIntervalMs") as u64 {
                c.last_ping = t;
                heartbeat = true;
                if c.ping.is_none() {
                    c.ping = Some(t);
                    self.send_c(cid, json!({"method":"Ping","data":t}));
                }
            }
        }
        if heartbeat {
            for r in self.rooms.values() {
                let mut data = json!({});
                for id in &r.active {
                    if let Some(rtt) = self.players.get(id).and_then(|p| p.rtt) {
                        data[id] = json!(rtt)
                    }
                }
                self.broadcast(r, json!({"method":"RoomRTT","data":data}), None, None)
            }
        }
        self.expire();
    }
    pub fn stop(&mut self) -> Result<()> {
        for cid in self.connections.keys() {
            self.close(*cid, 1001, "Server shutting down")
        }
        for r in self.rooms.values() {
            if r.persistent {
                self.store.save(r)?
            }
        }
        self.diagnostics.event("server stopped", json!({}));
        self.diagnostics.flush();
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disconnect_releases_delayed_and_queued_frame_allocations() {
        struct Payload(Arc<AtomicUsize>, [u8; 64]);
        impl AsRef<[u8]> for Payload {
            fn as_ref(&self) -> &[u8] {
                &self.1
            }
        }
        impl Drop for Payload {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::Relaxed);
            }
        }
        let live = Arc::new(AtomicUsize::new(1));
        let frame = Message::Binary(Bytes::from_owner(Payload(live.clone(), [0; 64])));
        let mut state = server();
        let (tx, rx) = mpsc::unbounded_channel();
        let (abort, _) = tokio::sync::watch::channel(false);
        state.connected(1, tx, Arc::new(AtomicUsize::new(0)), abort);
        state.delayed.push(Delayed {
            at: now() + 1000,
            cid: 1,
            version: 0,
            scoped: true,
            size: 64,
            frame: frame.clone(),
        });
        state.raw(1, frame);
        state.disconnect(1);
        assert!(state.delayed.is_empty());
        assert!(state.connections.is_empty());
        assert_eq!(live.load(Ordering::Relaxed), 1); // Socket receiver still owns its queued frame.
        drop(rx);
        assert_eq!(live.load(Ordering::Relaxed), 0);
    }
    fn server() -> Server {
        let mut c = Config::load().unwrap();
        c.0["sessionDirectory"] = json!("");
        c.0["verboseLogs"] = json!(false);
        c.0["maxBufferedBytes"] = json!(512);
        c.0["maxMessagesPerSecond"] = json!(20000);
        Server::new(c).unwrap()
    }
    #[test]
    fn moderation_ticket_is_signed_scoped_and_requires_a_visible_other_player() {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let mut s = server();
        s.config.0["maxBufferedBytes"] = json!(8192);
        let key = "test-signing-key-000000000000000001";
        s.config.0["moderationSigningKey"] = json!(key);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (abort, _) = tokio::sync::watch::channel(false);
        s.connected(1, tx, Arc::new(AtomicUsize::new(0)), abort);
        let mut reporter = Player::new("Reporter".into());
        reporter.connection = Some(1);
        let p = reporter.id.clone();
        s.players.insert(p.clone(), reporter);
        let target = Player::new("Target".into()).id;
        let room = Room::new("Room".into(), target.clone(), 4, Value::Null, Value::Null);
        let room_id = room.id.clone();
        s.rooms.insert(room_id.clone(), room);
        let req = id();
        let mut message = json!({"method":"getModerationTicket","data":{"requestId":req,"target":target,"room":room_id}});
        s.handle(1, &p, &message).unwrap();
        let response: Value =
            serde_json::from_str(rx.try_recv().unwrap().to_text().unwrap()).unwrap();
        let ticket = response["data"]["ticket"].as_str().unwrap();
        let (payload, signature) = ticket.split_once('.').unwrap();
        let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap())
            .unwrap();
        let data: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        assert_eq!(data["reporter"], p);
        assert_eq!(data["target"], target);
        assert_eq!(data["room"], room_id);
        assert_eq!(response["data"]["requestId"], req);
        assert!(data["expires"].as_u64().unwrap() > now());
        for denied_target in [p.clone(), id()] {
            message["data"]["target"] = json!(denied_target);
            s.handle(1, &p, &message).unwrap();
            let denied: Value =
                serde_json::from_str(rx.try_recv().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(denied["data"]["error"], "moderation_unavailable");
        }
    }
    #[test]
    fn control_bytes_abort_without_queueing_the_fifth_reply() {
        let mut s = server();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (abort, aborted) = tokio::sync::watch::channel(false);
        let q = Arc::new(AtomicUsize::new(0));
        s.connected(1, tx, q.clone(), abort);
        for _ in 0..10000 {
            s.receive(1, Message::Ping(Bytes::from(vec![0; 125])))
        }
        assert!(*aborted.borrow());
        assert_eq!(q.load(Ordering::Relaxed), 508);
        let mut count = 0;
        while let Ok(m) = rx.try_recv() {
            assert!(m.is_pong());
            count += 1
        }
        assert_eq!(count, 4);
    }
    #[test]
    fn rate_limit_fences_subsequent_messages() {
        let mut s = server();
        s.config.0["maxMessagesPerSecond"] = json!(4);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (abort, _) = tokio::sync::watch::channel(false);
        s.connected(1, tx, Arc::new(AtomicUsize::new(0)), abort);
        for _ in 0..100 {
            s.receive(1, Message::Ping(Bytes::from_static(b"x")))
        }
        let mut pongs = 0;
        let mut closes = 0;
        while let Ok(m) = rx.try_recv() {
            if m.is_pong() {
                pongs += 1
            }
            if m.is_close() {
                closes += 1
            }
        }
        assert_eq!((pongs, closes), (4, 1));
    }
}
