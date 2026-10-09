# Deployment example (not externally verified)

Run Node 24+, `npm ci`, `npm run build`, and supervise `npm start` with your service manager. Bind the backend to loopback, not the public interface:

```text
HOST=127.0.0.1
PORT=8080
ALLOWED_ORIGINS=https://game.example.com
ALLOW_NO_ORIGIN=false
```

Replace the example domain with your domain, point DNS at the host, and permit Caddy's HTTP/HTTPS certificate traffic. Use [Caddyfile.example](Caddyfile.example); its root must contain demo.html. The browser connects to `wss://game.example.com/`; `/healthz` proxies to the backend. Serve the page over HTTPS, not file://. Test certificate issuance, Origin rejection, health, reconnect, and two-client gameplay in your own environment: this example is not a claim of a tested external deployment.

Authentication is the first WebSocket frame. Never put account or room secrets in URL queries, analytics, access logs, console logs or exception reports. Disable proxy access logging unless a verified redaction policy exists; backend logging must not include payloads or URL queries. Protect sessionStorage from XSS with trusted static content and an appropriate production CSP (the demo currently uses an inline script).

Caddy forwards WebSocket upgrades automatically. The server intentionally uses the actual socket remote IP and does not trust X-Forwarded-For. Behind this loopback proxy **all clients share the proxy-IP connection and attempt quotas**. Account for this in MAX_CONNECTIONS_PER_IP and MAX_CONNECTIONS_PER_MINUTE without removing global bounds. Do not simply trust forwarded headers: individual client quotas require a separately designed trusted-proxy policy and network boundary. Origin allowlisting is browser protection, not authentication; native clients can spoof Origin.

Keep limits finite; budget process memory for accounts, rooms, payloads and queued sends. Monitor health, resource use and rejected traffic. Accounts are memory-only, offline TTL defaults to 300000 ms; rooms disappear on last active disconnect and everything disappears on restart. A started game can reconnect an eligible peer only while another peer remains active. There is no persistence, multi-node shared state or transparent failover.

The room owner controls game state. JSON sender identity is server supplied, but raw binary relay has no authenticated sender header. Client-authoritative gameplay cannot prevent cheating or guarantee fair results; implement server-authoritative validation for competitive or valuable outcomes. TLS and quotas do not change that trust boundary.
