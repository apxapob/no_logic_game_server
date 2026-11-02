//! Optional, room-scoped authenticated datagrams. Payloads remain opaque.
use crate::{model::now, server::Server, state::Shared};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{net::SocketAddr, sync::atomic::Ordering, time::Instant};
use tokio::{net::UdpSocket, sync::watch};

const HEADER: usize = 37;
const TAG: usize = 32;
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
pub(crate) struct Rate {
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
        }
    }
    fn packet(&mut self, cid: u64, kind: u8, sender: &[u8; 16], payload: &[u8]) -> Option<Vec<u8>> {
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
        self.datagram_at(bytes, source, now())
    }
    fn datagram_at(
        &mut self,
        bytes: &[u8],
        source: SocketAddr,
        t: u64,
    ) -> Vec<(SocketAddr, Vec<u8>)> {
        let mut output = Vec::new();
        if !(HEADER + TAG..=self.config.n("udpMaxDatagramBytes")).contains(&bytes.len())
            || &bytes[..4] != b"NLU1"
        {
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
        let incoming_limit = self.config.n("udpIncomingPacketsPerSecond");
        let outgoing_limit = self.config.n("udpOutgoingPacketsPerSecond");
        let endpoint_ttl = self.config.n("udpEndpointTtlMs") as u64;
        let challenge_ttl = self.config.n("udpChallengeTtlMs") as u64;
        let mut mac = Signature::new_from_slice(&session.secret).unwrap();
        mac.update(&bytes[..bytes.len() - TAG]);
        if mac.verify_slice(&bytes[bytes.len() - TAG..]).is_err() {
            return output;
        }
        if !session.replay.accept(sequence) {
            return output;
        }
        // Unauthenticated traffic is bounded by the listener's global budget.
        // It must not consume a victim's quota; captured replays must not either.
        // These counters belong to the WebSocket connection, not its rotating key.
        if !c.udp_incoming_rate.accept(t, incoming_limit) {
            return output;
        }
        match kind {
            0 => {
                let challenge: [u8; 16] = rand::random();
                session.challenge = Some((source, challenge, t));
                if c.udp_outgoing_rate.accept(t, outgoing_limit)
                    && let Some(packet) = session.packet(cid, 3, &[0; 16], &challenge)
                {
                    output.push((source, packet));
                }
            }
            1 => {
                if let Some((address, challenge, at)) = session.challenge
                    && address == source
                    && t.saturating_sub(at) <= challenge_ttl
                    && payload == challenge
                {
                    session.challenge = None;
                    session.endpoint = Some((source, t));
                    if c.udp_outgoing_rate.accept(t, outgoing_limit)
                        && let Some(packet) = session.packet(cid, 4, &[0; 16], &challenge)
                    {
                        output.push((source, packet));
                    }
                }
            }
            2 => {
                if !session.endpoint.is_some_and(|(address, at)| {
                    address == source && t.saturating_sub(at) <= endpoint_ttl
                }) {
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
                    if t.saturating_sub(at) > endpoint_ttl {
                        continue;
                    }
                    if connection.udp_outgoing_rate.accept(t, outgoing_limit)
                        && let Some(packet) =
                            session.packet(recipient, 5, sender.as_bytes(), payload)
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

pub async fn run(
    socket: UdpSocket,
    state: Shared,
    mut stop: watch::Receiver<bool>,
    config: crate::config::Config,
) {
    // One outstanding state command; no unbounded datagram tasks or queues.
    let max_packet = config.n("udpMaxDatagramBytes");
    let mut buffer = vec![0u8; max_packet + 1];
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
                        tokio::time::sleep(std::time::Duration::from_millis(config.n("udpReceiveErrorBackoffMs") as u64)).await;
                        continue;
                    }
                };
                if size > max_packet || !rate.accept(start.elapsed().as_millis() as u64, config.n("udpGlobalPacketsPerSecond")) { continue; }
                let bytes = buffer[..size].to_vec();
                let Ok(packets) = state.query(move |s| s.datagram(&bytes, source)).await else { break; };
                for (address, packet) in packets {
                    // Bound socket backpressure; UDP never builds an application queue.
                    let _ = tokio::time::timeout(std::time::Duration::from_millis(config.n("udpSendTimeoutMs") as u64), socket.send_to(&packet, address)).await;
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

    fn server_with_udp_players(count: u64) -> Server {
        let mut config = Config::load().unwrap();
        config.0["sessionDirectory"] = json!("");
        config.0["verboseLogs"] = json!(false);
        config.0["udpEnabled"] = json!(true);
        config.0["maxMessagesPerSecond"] = json!(120);
        config.0["udpIncomingPacketsPerSecond"] = json!(120);
        config.0["udpOutgoingPacketsPerSecond"] = json!(120);
        config.0["sendDelayMs"] = json!(0);
        let mut server = Server::new(config).unwrap();
        let mut room = Room::new(
            "test".into(),
            String::new(),
            count as usize,
            json!(null),
            json!(null),
        );
        for cid in 1..=count {
            let (tx, _rx) = mpsc::unbounded_channel();
            let (abort, _) = watch::channel(false);
            server.connected(cid, tx, Arc::new(AtomicUsize::new(0)), abort);
            let mut player = Player::new("test".into());
            if cid == 1 {
                room.owner = player.id.clone();
            }
            room.active.insert(player.id.clone());
            player.connection = Some(cid);
            player.room = Some(room.id.clone());
            let c = server.connections.get_mut(&cid).unwrap();
            c.player = Some(player.id.clone());
            c.udp = Some(Session::new(0));
            server.players.insert(player.id.clone(), player);
        }
        server.rooms.insert(room.id.clone(), room);
        server
    }
    #[test]
    fn challenges_expire_and_cannot_bind_another_source_or_exceed_budgets() {
        let mut server = server_with_udp_players(1);
        let key = server.connections[&1].udp.as_ref().unwrap().secret;
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
        let expired = now() - server.config.n("udpEndpointTtlMs") as u64 - 1;
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
        let connection = server.connections.get_mut(&1).unwrap();
        connection.udp_incoming_rate = Rate {
            at: now(),
            count: 120,
        };
        server.config.0["maxMessagesPerSecond"] = json!(120);
        assert!(
            server
                .datagram(&encode(&key, 0, 1, 7, &[0; 16], &[0; 16]), address)
                .is_empty()
        );
        let connection = server.connections.get_mut(&1).unwrap();
        connection.udp_incoming_rate = Rate::default();
        connection.udp_outgoing_rate = Rate {
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
    fn configured_quotas_and_timeouts_are_enforced() {
        let mut server = server_with_udp_players(2);
        server.config.0["udpIncomingPacketsPerSecond"] = json!(2);
        server.config.0["udpOutgoingPacketsPerSecond"] = json!(1);
        server.config.0["udpChallengeTtlMs"] = json!(10);
        server.config.0["udpEndpointTtlMs"] = json!(20);
        let from = "127.0.0.1:10001".parse().unwrap();
        let to = "127.0.0.1:10002".parse().unwrap();
        let key = server.connections[&1].udp.as_ref().unwrap().secret;
        let t = 10000;
        let reply = server.datagram_at(&encode(&key, 0, 1, 1, &[0; 16], &[0; 16]), from, t);
        assert_eq!(reply.len(), 1);
        assert!(
            server
                .datagram_at(
                    &encode(&key, 1, 1, 2, &[0; 16], &reply[0].1[37..53]),
                    from,
                    t + 11
                )
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
        // Reset only the test counters, then isolate the input and recipient output quotas.
        server.connections.get_mut(&1).unwrap().udp_incoming_rate = Rate::default();
        server
            .connections
            .get_mut(&1)
            .unwrap()
            .udp
            .as_mut()
            .unwrap()
            .endpoint = Some((from, t));
        server
            .connections
            .get_mut(&2)
            .unwrap()
            .udp
            .as_mut()
            .unwrap()
            .endpoint = Some((to, t));
        assert_eq!(
            server
                .datagram_at(&encode(&key, 2, 1, 3, &[0; 16], b"a"), from, t)
                .len(),
            1
        );
        assert!(
            server
                .datagram_at(&encode(&key, 2, 1, 4, &[0; 16], b"b"), from, t)
                .is_empty()
        );
        assert_eq!(server.connections[&1].udp_incoming_rate.count, 2);
        assert_eq!(server.connections[&2].udp_outgoing_rate.count, 1);
        assert!(
            server
                .datagram_at(&encode(&key, 0, 1, 5, &[0; 16], &[0; 16]), from, t)
                .is_empty()
        );
        // Next rate window: expired endpoints do not route or refresh their binding.
        assert!(
            server
                .datagram_at(&encode(&key, 2, 1, 6, &[0; 16], b"expired"), from, t + 1000)
                .is_empty()
        );
        assert_eq!(
            server.connections[&1]
                .udp
                .as_ref()
                .unwrap()
                .endpoint
                .unwrap()
                .1,
            t
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

    #[test]
    fn forged_packets_and_captured_replays_cannot_spend_a_victims_quota() {
        let mut server = server_with_udp_players(1);
        let key = server.connections[&1].udp.as_ref().unwrap().secret;
        let victim = "127.0.0.1:10001".parse().unwrap();
        let attacker = "127.0.0.1:10002".parse().unwrap();
        let t = now();
        for seq in 1..=120 {
            let forged = encode(&[0; 32], 0, 1, seq, &[0; 16], &[0; 16]);
            assert!(server.datagram_at(&forged, attacker, t).is_empty());
        }
        let probe = encode(&key, 0, 1, 1, &[0; 16], &[0; 16]);
        assert_eq!(server.datagram_at(&probe, victim, t).len(), 1);
        for _ in 0..120 {
            assert!(server.datagram_at(&probe, attacker, t).is_empty());
        }
        assert_eq!(server.connections[&1].udp_incoming_rate.count, 1);
        assert_eq!(
            server
                .datagram_at(&encode(&key, 0, 1, 2, &[0; 16], &[0; 16]), victim, t)
                .len(),
            1
        );
    }

    fn rotate(server: &mut Server, cid: u64, close_first: bool) {
        use tokio_tungstenite::tungstenite::Message;
        if close_first {
            server.receive(
                cid,
                Message::Text(json!({"method":"closeUdp","data":null}).to_string().into()),
            );
            assert!(server.connections[&cid].udp.is_none());
        }
        server.receive(
            cid,
            Message::Text(json!({"method":"openUdp","data":null}).to_string().into()),
        );
        assert!(server.connections[&cid].udp.is_some());
    }

    #[test]
    fn key_rotation_and_close_open_preserve_both_connection_budgets() {
        // Fixed UDP time keeps this regression independent of machine speed.
        // Exercise actual WebSocket open/close handlers rather than replacing sessions directly.
        let mut server = server_with_udp_players(3);
        let t = now();
        let from = "127.0.0.1:10001".parse().unwrap();
        let to = "127.0.0.1:10002".parse().unwrap();
        let recipient =
            uuid::Uuid::parse_str(server.connections[&2].player.as_ref().unwrap()).unwrap();
        let mut seq = 0;
        for round in 0..3 {
            let old_key = server.connections[&1].udp.as_ref().unwrap().secret;
            rotate(&mut server, 1, round == 2);
            rotate(&mut server, 2, round == 2);
            let key = server.connections[&1].udp.as_ref().unwrap().secret;
            assert_ne!(old_key, key);
            // Binding is covered separately. Bypass it here so the test isolates
            // game-data budgets, without handshake replies consuming output slots.
            server
                .connections
                .get_mut(&1)
                .unwrap()
                .udp
                .as_mut()
                .unwrap()
                .endpoint = Some((from, t));
            server
                .connections
                .get_mut(&2)
                .unwrap()
                .udp
                .as_mut()
                .unwrap()
                .endpoint = Some((to, t));
            for _ in 0..110 {
                seq += 1;
                let out = server.datagram_at(
                    &encode(&key, 2, 1, seq, recipient.as_bytes(), b"data"),
                    from,
                    t,
                );
                assert_eq!(out.len(), usize::from(seq <= 120));
            }
            assert_eq!(
                server.connections[&1].udp_incoming_rate.count,
                seq.min(120) as usize
            );
            assert_eq!(
                server.connections[&2].udp_outgoing_rate.count,
                seq.min(120) as usize
            );
        }
        // A different sender with a fresh budget still cannot exceed this recipient's output quota.
        let third = "127.0.0.1:10003".parse().unwrap();
        server
            .connections
            .get_mut(&3)
            .unwrap()
            .udp
            .as_mut()
            .unwrap()
            .endpoint = Some((third, t));
        let key = server.connections[&3].udp.as_ref().unwrap().secret;
        assert!(
            server
                .datagram_at(
                    &encode(&key, 2, 3, 1, recipient.as_bytes(), b"limited output"),
                    third,
                    t
                )
                .is_empty()
        );
        // The existing windows, rather than key rotation, restore delivery at their expiry.
        assert!(
            server
                .datagram_at(
                    &encode(&key, 2, 3, 2, recipient.as_bytes(), b"early"),
                    third,
                    t + 999
                )
                .is_empty()
        );
        assert_eq!(
            server
                .datagram_at(
                    &encode(&key, 2, 3, 3, recipient.as_bytes(), b"next window"),
                    third,
                    t + 1000
                )
                .len(),
            1
        );
        let key = server.connections[&1].udp.as_ref().unwrap().secret;
        assert_eq!(
            server
                .datagram_at(
                    &encode(&key, 2, 1, 331, recipient.as_bytes(), b"restored input"),
                    from,
                    t + 1000
                )
                .len(),
            1
        );
    }
}
