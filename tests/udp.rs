#[path = "../rust/tooling/mod.rs"]
mod support;
use anyhow::Result;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;
use support::*;
use tokio::net::UdpSocket;
use uuid::Uuid;

struct Peer {
    socket: UdpSocket,
    cid: u64,
    secret: Vec<u8>,
    sequence: u64,
}
impl Peer {
    async fn open(client: &mut Client) -> Result<Self> {
        client.send("openUdp", json!(null))?;
        let data = client.wait("udpSession").await?;
        assert_eq!(data["maxDatagramBytes"], 1200);
        let socket = UdpSocket::bind("127.0.0.1:0").await?;
        socket
            .connect(("127.0.0.1", data["port"].as_u64().unwrap() as u16))
            .await?;
        Ok(Self {
            socket,
            cid: data["connectionId"].as_str().unwrap().parse()?,
            secret: base64::engine::general_purpose::STANDARD
                .decode(data["secret"].as_str().unwrap())?,
            sequence: 0,
        })
    }
    fn packet(&mut self, kind: u8, target: Uuid, payload: &[u8]) -> Vec<u8> {
        self.sequence += 1;
        let mut b = b"NLU1".to_vec();
        b.push(kind);
        b.extend_from_slice(&self.cid.to_be_bytes());
        b.extend_from_slice(&self.sequence.to_be_bytes());
        b.extend_from_slice(target.as_bytes());
        b.extend_from_slice(payload);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).unwrap();
        mac.update(&b);
        b.extend_from_slice(&mac.finalize().into_bytes());
        b
    }
    async fn send(&mut self, kind: u8, target: Uuid, payload: &[u8]) -> Result<Vec<u8>> {
        let packet = self.packet(kind, target, payload);
        self.socket.send(&packet).await?;
        Ok(packet)
    }
    async fn receive(&self, kind: u8) -> Result<Vec<u8>> {
        let mut b = vec![0; 1500];
        let n = tokio::time::timeout(WAIT, self.socket.recv(&mut b)).await??;
        b.truncate(n);
        assert!(n >= 69);
        assert_eq!(&b[..4], b"NLU1");
        assert_eq!(b[4], kind);
        assert_eq!(u64::from_be_bytes(b[5..13].try_into().unwrap()), self.cid);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).unwrap();
        mac.update(&b[..n - 32]);
        mac.verify_slice(&b[n - 32..])?;
        Ok(b)
    }
    async fn bind(&mut self) -> Result<()> {
        self.send(0, Uuid::nil(), &[0; 16]).await?;
        let challenge = self.receive(3).await?;
        self.send(1, Uuid::nil(), &challenge[37..53]).await?;
        self.receive(4).await?;
        Ok(())
    }
    async fn silent(&self) {
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(100),
                self.socket.recv(&mut [0; 1500])
            )
            .await
            .is_err()
        );
    }
}

#[tokio::test]
async fn optional_udp_authenticated_room_routing_and_revocation() -> Result<()> {
    let mut server =
        Relay::start(json!({"udpEnabled":true,"udpPort":0,"maxMessagesPerSecond":1000})).await?;
    let mut host = Client::connect(&server.url).await?;
    host.error("openUdp", json!(null), "no_room").await?;
    let room = host.room(json!({})).await?;
    let mut peer = Client::connect(&server.url).await?;
    peer.enter(&room).await?;
    let mut third = Client::connect(&server.url).await?;
    third.enter(&room).await?;
    let mut other = Client::connect(&server.url).await?;
    other.room(json!({})).await?;
    let mut a = Peer::open(&mut host).await?;
    let mut b = Peer::open(&mut peer).await?;
    b.bind().await?;
    let mut c = Peer::open(&mut third).await?;
    c.bind().await?;
    let mut d = Peer::open(&mut other).await?;
    d.bind().await?;
    // No data relay before proving possession of the UDP endpoint.
    a.send(2, Uuid::nil(), b"unbound").await?;
    b.silent().await;
    a.bind().await?;
    let packet = a.send(2, Uuid::nil(), b"broadcast").await?;
    for target in [&b, &c] {
        let reply = target.receive(5).await?;
        assert_eq!(&reply[21..37], Uuid::parse_str(host.id())?.as_bytes());
        assert_eq!(&reply[37..reply.len() - 32], b"broadcast");
    }
    a.silent().await;
    d.silent().await;
    a.socket.send(&packet).await?;
    b.silent().await;
    c.silent().await;
    a.send(2, Uuid::parse_str(peer.id())?, &vec![42; 1131])
        .await?;
    assert_eq!(b.receive(5).await?.len(), 1200);
    c.silent().await;
    a.send(2, Uuid::parse_str(other.id())?, b"different room")
        .await?;
    d.silent().await;
    // Bad authentication, malformed, oversized and reflected server frames drop silently.
    let mut bad = a.packet(2, Uuid::nil(), b"tampered");
    bad[37] ^= 1;
    a.socket.send(&bad).await?;
    a.socket.send(b"NLU1").await?;
    a.send(2, Uuid::nil(), &vec![1; 1132]).await?;
    // Larger than the receive buffer: Windows reports WSAEMSGSIZE, Linux truncates.
    a.send(2, Uuid::nil(), &vec![1; 8192]).await?;
    a.send(5, Uuid::nil(), b"wrong direction").await?;
    b.silent().await;
    // An authenticated packet from another source socket cannot steal a bound endpoint.
    let rogue = UdpSocket::bind("127.0.0.1:0").await?;
    rogue
        .send_to(
            &a.packet(2, Uuid::nil(), b"wrong source"),
            a.socket.peer_addr()?,
        )
        .await?;
    b.silent().await;
    // The replay window still delivers out-of-order packets exactly once.
    let older = a.packet(2, Uuid::parse_str(peer.id())?, b"older");
    a.send(2, Uuid::parse_str(peer.id())?, b"newer").await?;
    b.receive(5).await?;
    a.socket.send(&older).await?;
    b.receive(5).await?;
    // Reissuing a session invalidates its old key.
    let mut replacement = Peer::open(&mut host).await?;
    replacement.bind().await?;
    a.send(2, Uuid::nil(), b"old key").await?;
    b.silent().await;
    replacement
        .send(2, Uuid::parse_str(peer.id())?, b"new key")
        .await?;
    b.receive(5).await?;
    // Leaving and returning does not revive a stale UDP session.
    peer.send("leaveRoom", json!(null))?;
    host.wait("playerLeft").await?;
    peer.enter(&room).await?;
    replacement
        .send(2, Uuid::parse_str(peer.id())?, b"stale receiver")
        .await?;
    b.silent().await;
    b.send(2, Uuid::nil(), b"stale sender").await?;
    replacement.silent().await;
    let mut b = Peer::open(&mut peer).await?;
    b.bind().await?;
    replacement
        .send(2, Uuid::parse_str(peer.id())?, b"rejoined")
        .await?;
    b.receive(5).await?;
    // Replacing the WebSocket revokes the old datagram key, even with room restoration.
    let mut reconnected = Client::auth(&server.url, host.account.clone()).await?;
    replacement
        .send(2, Uuid::nil(), b"stale connection")
        .await?;
    b.silent().await;
    let mut replacement = Peer::open(&mut reconnected).await?;
    replacement.bind().await?;
    reconnected.send("closeUdp", json!(null))?;
    reconnected.wait("udpClosed").await?;
    replacement.send(2, Uuid::nil(), b"closed").await?;
    b.silent().await;
    // Ordinary room traffic continues to work.
    reconnected.send("sendToRoom", json!("websocket still works"))?;
    assert_eq!(
        peer.wait("messageFromPlayer").await?["msg"],
        "websocket still works"
    );
    server.stop().await?;
    Ok(())
}

#[tokio::test]
async fn udp_is_disabled_by_default() -> Result<()> {
    let server = Relay::start(json!({"udpEnabled":false})).await?;
    let mut peer = Client::connect(&server.url).await?;
    peer.error("openUdp", json!(null), "udp_disabled").await?;
    Ok(())
}
