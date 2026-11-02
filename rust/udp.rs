//! Optional, room-scoped authenticated datagrams. Payloads remain opaque.
use crate::{model::now, server::Server, state::Shared};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{net::SocketAddr, sync::atomic::Ordering, time::Instant};
use tokio::{net::UdpSocket, sync::watch};

pub const MAX_PACKET: usize = 1200;
const HEADER: usize = 37;
const TAG: usize = 32;
const TTL: u64 = 60_000;
type Signature = Hmac<Sha256>;

#[derive(Default)]
struct Replay {
    highest: u64,
    bits: u64,
}
impl Replay {
    fn accept(&mut self, sequence: u64) -> bool {
        if sequence == 0 {
            return false;
        }
        if sequence > self.highest {
            let shift = sequence - self.highest;
            self.bits = if shift >= 64 {
                1
            } else {
                (self.bits << shift) | 1
            };
            self.highest = sequence;
            return true;
        }
        let distance = self.highest - sequence;
        if distance >= 64 || self.bits & (1 << distance) != 0 {
            return false;
        }
        self.bits |= 1 << distance;
        true
    }
}
#[derive(Default)]
struct Rate {
    at: u64,
    count: usize,
}
impl Rate {
    fn accept(&mut self, t: u64, limit: usize) -> bool {
        if t.saturating_sub(self.at) >= 1000 {
            self.at = t;
            self.count = 0;
        }
        if self.count >= limit {
            return false;
        }
        self.count += 1;
        true
    }
}
pub struct Session {
    pub secret: [u8; 32],
    version: u64,
    replay: Replay,
    outgoing: u64,
    endpoint: Option<(SocketAddr, u64)>,
    challenge: Option<(SocketAddr, [u8; 16], u64)>,
    incoming_rate: Rate,
    outgoing_rate: Rate,
}
impl Session {
    pub fn new(version: u64) -> Self {
        Self {
            secret: rand::random(),
            version,
            replay: Replay::default(),
            outgoing: 0,
            endpoint: None,
            challenge: None,
            incoming_rate: Rate::default(),
            outgoing_rate: Rate::default(),
        }
    }
    fn packet(
        &mut self,
        cid: u64,
        kind: u8,
        sender: &[u8; 16],
        payload: &[u8],
        t: u64,
        limit: usize,
    ) -> Option<Vec<u8>> {
        if !self.outgoing_rate.accept(t, limit) {
            return None;
        }
        self.outgoing = self.outgoing.checked_add(1)?;
        Some(encode(
            &self.secret,
            kind,
            cid,
            self.outgoing,
            sender,
            payload,
        ))
    }
}
fn encode(
    secret: &[u8],
    kind: u8,
    cid: u64,
    sequence: u64,
    address: &[u8; 16],
    payload: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER + payload.len() + TAG);
    bytes.extend_from_slice(b"NLU1");
    bytes.push(kind);
    bytes.extend_from_slice(&cid.to_be_bytes());
    bytes.extend_from_slice(&sequence.to_be_bytes());
    bytes.extend_from_slice(address);
    bytes.extend_from_slice(payload);
    let mut mac = Signature::new_from_slice(secret).unwrap();
    mac.update(&bytes);
    bytes.extend_from_slice(&mac.finalize().into_bytes());
    bytes
}
impl Server {
    pub fn datagram(&mut self, bytes: &[u8], source: SocketAddr) -> Vec<(SocketAddr, Vec<u8>)> {
        let mut output = Vec::new();
        if !(HEADER + TAG..=MAX_PACKET).contains(&bytes.len()) || &bytes[..4] != b"NLU1" {
            return output;
        }
        let kind = bytes[4];
        let payload = &bytes[HEADER..bytes.len() - TAG];
        if !matches!(kind, 0..=2)
            || (kind != 2 && payload.len() != 16)
            || (kind == 2 && payload.is_empty())
        {
            return output;
        }
        let cid = u64::from_be_bytes(bytes[5..13].try_into().unwrap());
        let sequence = u64::from_be_bytes(bytes[13..21].try_into().unwrap());
        let target = uuid::Uuid::from_slice(&bytes[21..37]).unwrap();
        if kind != 2 && !target.is_nil() {
            return output;
        }
        let Some(c) = self.connections.get_mut(&cid) else {
            return output;
        };
        if c.closing.load(Ordering::Relaxed) {
            return output;
        }
        let Some(player) = c.player.as_ref().and_then(|p| self.players.get(p)) else {
            return output;
        };
        if player.connection != Some(cid) {
            return output;
        }
        let Some(room) = player.room.as_ref().and_then(|r| self.rooms.get(r)) else {
            return output;
        };
        if !room.active.contains(&player.id) {
            return output;
        }
        let Some(session) = c.udp.as_mut().filter(|u| u.version == player.version) else {
            return output;
        };
        let t = now();
        let limit = self.config.n("maxMessagesPerSecond");
        // Bound even failed authentication attempts against a known connection.
        if !session.incoming_rate.accept(t, limit) {
            return output;
        }
        let mut mac = Signature::new_from_slice(&session.secret).unwrap();
        mac.update(&bytes[..bytes.len() - TAG]);
        if mac.verify_slice(&bytes[bytes.len() - TAG..]).is_err() {
            return output;
        }
        if !session.replay.accept(sequence) {
            return output;
        }
        match kind {
            0 => {
                let challenge: [u8; 16] = rand::random();
                session.challenge = Some((source, challenge, t));
                if let Some(packet) = session.packet(cid, 3, &[0; 16], &challenge, t, limit) {
                    output.push((source, packet));
                }
            }
            1 => {
                if let Some((address, challenge, at)) = session.challenge
                    && address == source
                    && t.saturating_sub(at) <= 5000
                    && payload == challenge
                {
                    session.challenge = None;
                    session.endpoint = Some((source, t));
                    if let Some(packet) = session.packet(cid, 4, &[0; 16], &challenge, t, limit) {
                        output.push((source, packet));
                    }
                }
            }
            2 => {
                if !session
                    .endpoint
                    .is_some_and(|(address, at)| address == source && t.saturating_sub(at) <= TTL)
                {
                    return output;
                }
                session.endpoint = Some((source, t));
                let sender = uuid::Uuid::parse_str(&player.id).unwrap();
                let recipients: Vec<_> = room
                    .active
                    .iter()
                    .filter(|id| {
                        **id != player.id && (target.is_nil() || **id == target.to_string())
                    })
                    .filter_map(|id| self.players.get(id))
                    .filter_map(|p| p.connection.map(|cid| (cid, p.version)))
                    .collect();
                for (recipient, version) in recipients {
                    let Some(connection) = self.connections.get_mut(&recipient) else {
                        continue;
                    };
                    if connection.closing.load(Ordering::Relaxed) {
                        continue;
                    }
                    let Some(session) = connection.udp.as_mut().filter(|u| u.version == version)
                    else {
                        continue;
                    };
                    let Some((address, at)) = session.endpoint else {
                        continue;
                    };
                    if t.saturating_sub(at) > TTL {
                        continue;
                    }
                    if let Some(packet) =
                        session.packet(recipient, 5, sender.as_bytes(), payload, t, limit)
                    {
                        output.push((address, packet));
                    }
                }
            }
            _ => unreachable!(),
        }
        output
    }
}

pub async fn run(socket: UdpSocket, state: Shared, mut stop: watch::Receiver<bool>) {
    // One outstanding state command; no unbounded datagram tasks or queues.
    let mut buffer = [0u8; MAX_PACKET + 1];
    let start = Instant::now();
    let mut rate = Rate::default();
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            received = socket.recv_from(&mut buffer) => {
                let (size, source) = match received {
                    Ok(value) => value,
                    // Windows reports WSAEMSGSIZE instead of returning truncated
                    // bytes. ICMP from a departed peer can also surface here.
                    // Neither may take down the shared UDP listener.
                    Err(error) if error.raw_os_error() == Some(10040)
                        || matches!(error.kind(), std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionRefused
                            | std::io::ErrorKind::Interrupted
                            | std::io::ErrorKind::WouldBlock) => continue,
                    Err(_) => {
                        // Avoid a tight loop on a persistent OS/socket failure.
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                };
                if size > MAX_PACKET || !rate.accept(start.elapsed().as_millis() as u64, 4096) { continue; }
                let bytes = buffer[..size].to_vec();
                let Ok(packets) = state.query(move |s| s.datagram(&bytes, source)).await else { break; };
                for (address, packet) in packets {
                    // Bound socket backpressure; UDP never builds an application queue.
                    let _ = tokio::time::timeout(std::time::Duration::from_millis(2), socket.send_to(&packet, address)).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Config,
        model::{Player, Room},
    };
    use serde_json::json;
    use std::sync::{Arc, atomic::AtomicUsize};
    use tokio::sync::mpsc;

    #[test]
    fn challenges_expire_and_cannot_bind_another_source_or_exceed_budgets() {
        let mut config = Config::load().unwrap();
        config.0["sessionDirectory"] = json!("");
        config.0["verboseLogs"] = json!(false);
        let mut server = Server::new(config).unwrap();
        let (tx, _rx) = mpsc::unbounded_channel();
        let (abort, _) = watch::channel(false);
        server.connected(1, tx, Arc::new(AtomicUsize::new(0)), abort);
        let mut player = Player::new("test".into());
        let mut room = Room::new(
            "test".into(),
            player.id.clone(),
            2,
            json!(null),
            json!(null),
        );
        room.active.insert(player.id.clone());
        player.connection = Some(1);
        player.room = Some(room.id.clone());
        let c = server.connections.get_mut(&1).unwrap();
        c.player = Some(player.id.clone());
        c.udp = Some(Session::new(0));
        let key = c.udp.as_ref().unwrap().secret;
        server.players.insert(player.id.clone(), player);
        server.rooms.insert(room.id.clone(), room);
        let address: SocketAddr = "127.0.0.1:10001".parse().unwrap();
        let other: SocketAddr = "127.0.0.1:10002".parse().unwrap();
        let reply = server.datagram(&encode(&key, 0, 1, 1, &[0; 16], &[0; 16]), address);
        assert_eq!(reply.len(), 1);
        assert_eq!(reply[0].1.len(), 85);
        let challenge = &reply[0].1[37..53];
        assert!(
            server
                .datagram(&encode(&key, 1, 1, 2, &[0; 16], challenge), other)
                .is_empty()
        );
        assert!(
            server.connections[&1]
                .udp
                .as_ref()
                .unwrap()
                .endpoint
                .is_none()
        );
        server
            .connections
            .get_mut(&1)
            .unwrap()
            .udp
            .as_mut()
            .unwrap()
            .challenge
            .as_mut()
            .unwrap()
            .2 = now() - 5001;
        assert!(
            server
                .datagram(&encode(&key, 1, 1, 3, &[0; 16], challenge), address)
                .is_empty()
        );
        let reply = server.datagram(&encode(&key, 0, 1, 4, &[0; 16], &[0; 16]), address);
        assert_eq!(
            server
                .datagram(
                    &encode(&key, 1, 1, 5, &[0; 16], &reply[0].1[37..53]),
                    address
                )
                .len(),
            1
        );
        let expired = now() - TTL - 1;
        server
            .connections
            .get_mut(&1)
            .unwrap()
            .udp
            .as_mut()
            .unwrap()
            .endpoint = Some((address, expired));
        server.datagram(&encode(&key, 2, 1, 6, &[0; 16], b"expired"), address);
        assert_eq!(
            server.connections[&1]
                .udp
                .as_ref()
                .unwrap()
                .endpoint
                .unwrap()
                .1,
            expired
        );
        // Exhaust incoming budget: even authenticated probes cannot produce replies.
        let session = server
            .connections
            .get_mut(&1)
            .unwrap()
            .udp
            .as_mut()
            .unwrap();
        session.incoming_rate = Rate {
            at: now(),
            count: 120,
        };
        server.config.0["maxMessagesPerSecond"] = json!(120);
        assert!(
            server
                .datagram(&encode(&key, 0, 1, 7, &[0; 16], &[0; 16]), address)
                .is_empty()
        );
        let session = server
            .connections
            .get_mut(&1)
            .unwrap()
            .udp
            .as_mut()
            .unwrap();
        session.incoming_rate = Rate::default();
        session.outgoing_rate = Rate {
            at: now(),
            count: 120,
        };
        assert!(
            server
                .datagram(&encode(&key, 0, 1, 8, &[0; 16], &[0; 16]), address)
                .is_empty()
        );
    }
    #[test]
    fn replay_window_allows_reordering_but_not_duplicates_or_old_packets() {
        let mut replay = Replay::default();
        for n in [1, 3, 2, 65, 64, 4] {
            assert!(replay.accept(n));
        }
        for n in [0, 1, 2, 3, 4, 65] {
            assert!(!replay.accept(n));
        }
        assert!(replay.accept(u64::MAX));
        assert!(!replay.accept(65));
    }
}
