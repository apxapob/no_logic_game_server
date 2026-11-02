# Optional UDP relay v1

This channel is for native clients (including Unity). It complements the existing
WebSocket connection: authenticate, enter rooms and send reliable events through
WebSocket; explicitly open UDP for small, replaceable updates. The relay never
interprets game data. Existing clients need no changes.

## Configuration

UDP is disabled by default. Set `UDP_ENABLED=true`, `UDP_HOST=0.0.0.0` and
`UDP_PORT=8080` to expose IPv4 UDP on port 8080. UDP binds separately from `HOST`
and `PORT`, so WebSocket can remain on loopback behind an HTTPS reverse proxy.
`UDP_HOST` defaults to `127.0.0.1`; `UDP_PORT` defaults to 8080. Port zero chooses
an ephemeral port for tests. A bind failure fails server startup.

Open/forward the UDP port explicitly in the firewall/NAT or UDP-aware proxy.
An ordinary HTTP/WebSocket reverse proxy does not forward this channel. Clients
use the public server hostname and advertised UDP port; external port mappings
must preserve that port (or clients must override the endpoint).

## Session and endpoint establishment

1. Authenticate over **WSS** and enter a room. `onConnected.data.udpRelay` advertises
   `{version:1,port,maxDatagramBytes:1200}` when enabled.
2. Send WebSocket `{"method":"openUdp","data":null}`. The `udpSession` response
   data contains `connectionId` (a decimal string encoding u64), `secret` (standard
   Base64, 32 random bytes), `version`, `port`, and `maxDatagramBytes`.
   Calling again replaces the key and resets the UDP session, but preserves the
   WebSocket connection's UDP rate budgets and their current windows.
3. From the UDP socket, send a signed **probe**, kind 0, with a zero address and
   16 padding bytes. The server returns kind 3 with a random 16-byte challenge.
4. Verify the response signature, connection ID, kind, and replay sequence. Send
   kind 1 with that challenge as payload and a zero address. The server binds the
   observed source IP/port only if the challenge matches, comes from the same
   endpoint, and is at most five seconds old. Kind 4 acknowledges the binding.
5. Send kind 2 payloads. Other opted-in, bound peers receive kind 5 datagrams.

Retry the handshake with a new probe and increasing packet sequences if a response
is lost. The endpoint expires after 60 seconds without valid incoming relay data
or a successful handshake. Receive-only clients should repeat the handshake every
20 seconds. Repeat it after a network/NAT change. The old endpoint can remain active
until the new challenge is confirmed. A probe alone never redirects game traffic.

`closeUdp` with null data revokes the key and replies `udpClosed`. Disconnect,
WebSocket replacement, leaving/re-entering a room, or room membership version
changes invalidate the channel. After any room transition, call `openUdp` again.
Keys and endpoints are never persisted. `openUdp` reports `udp_disabled` or
`no_room` through the normal WebSocket error mechanism when appropriate.

## Datagram layout

All integers are **unsigned, big-endian**. UUIDs use RFC/network byte order,
which differs from the default `.NET Guid.ToByteArray()` layout.

| Offset | Size | Field |
|---|---:|---|
| 0 | 4 | ASCII `NLU1` |
| 4 | 1 | Kind: 0 probe, 1 confirm, 2 relay, 3 challenge, 4 bound, 5 delivered |
| 5 | 8 | Connection ID: sender's for client→server, recipient's for server→client |
| 13 | 8 | Sequence, starting at 1; independent client and server counters |
| 21 | 16 | Kind 2: target player UUID, all zeros for room broadcast. Kind 5: authenticated sender UUID. Other kinds: all zeros. |
| 37 | variable | Opaque payload (kind 2/5: 1–1131 bytes; handshake: exactly 16 bytes) |
| final 32 | 32 | HMAC-SHA256 of all preceding bytes, using this connection's secret |

Each complete datagram is at most 1200 bytes. The server creates a separate signed
packet for each recipient, replaces the address with the authenticated sender,
and uses the recipient's key/counter. It never forwards the sender's credentials.
Native .NET clients can compute/verify the signature with `HMACSHA256`; compare
tags in constant time. Accept only server kinds 3/4/5 from the configured endpoint.

The relay rejects duplicate sequences and sequences more than 63 behind the
highest accepted value, while allowing reordering within that window. Clients
must apply equivalent replay checks to server packets. Never reuse a sequence
under the same key; open a new session before u64 overflow. Add application tick
numbers inside the payload if stale movement updates should be discarded.

## Delivery and limits

- Broadcast excludes the sender; unicast is restricted to active peers in the same
  room. Only peers with a valid UDP binding receive data. There is no automatic
  WebSocket fallback, acknowledgement or retransmission of game packets.
- Incoming and outgoing UDP packets each have a separate per-connection budget
  of `MAX_MESSAGES_PER_SECOND` (default 120), including handshake packets. The
  listener admits at most 4096 datagrams/second globally. Over-budget, invalid,
  oversized and unauthenticated datagrams are silently dropped.
  Failed HMAC verification and captured replays do not consume the identified
  player's budget; unauthenticated traffic remains subject to the global limit.
  Key rotation and `closeUdp`/`openUdp` do not reset either connection budget.
- The listener requests 1 MiB receive/send socket buffers to absorb bounded bursts;
  the operating system may cap or adjust these values. This does not remove loss
  or replace application-level congestion control.
- There is at most one UDP state command outstanding; no per-packet spawned tasks
  or unbounded application queue. Socket sends have a two-millisecond deadline.
  `SEND_DELAY_MS` only applies to WebSocket traffic, not UDP.
- HMAC authenticates packets but **does not encrypt their payloads**. Exchange keys
  over WSS in production; keep sensitive data on WSS. UDP secrets are redacted by
  the existing log redactor, and UDP payloads are not logged.

Do not send indispensable simulation events through this best-effort channel.
For Vampire Towers, sequential shared ticks/RPCs still need reliable delivery;
independent movement/aim snapshots may use UDP after client-side integration.
This server feature does not change the Unity client or its Netcode transport.

Run `cargo test --test udp --locked` for real-socket routing, handshake, authentication,
room isolation, replay, size bounds and lifecycle checks.

For authorized external stress tests, `scripts/udp-stress.py` provides bounded
load, soak and churn modes; `scripts/udp-adversarial.py` checks malformed traffic,
replay, cross-room routing, NAT rebinding, key rotation and real endpoint expiry.
They require Python 3.11+ and `websockets`. Both require explicit WebSocket and
UDP endpoints. Use WSS or an SSH-forwarded WebSocket endpoint for the control
channel. Churn alternates graceful closes and abruptly aborted connections.
The load generator validates every delivered payload, authenticated sender and
room, and reports missing/duplicate packets and end-to-end relay-path latency
on one local clock. This latency includes client→server→client travel; it is
not a server-only processing time. Monitor the server and generator independently;
rate-limit drops and generator saturation are not measures of maximum CPU capacity.

See the [2026-11-02 external stress-test report](udp-stress-2026-11-02.md)
for measured delivery, memory, lifecycle checks and the Windows receive-error fix.
