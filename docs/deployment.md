# Deployment example (not externally verified)

Run Node 24+, `npm ci`, `npm run build`, and supervise `npm start` with your service manager. Bind the backend to loopback, not the public interface:

```text
HOST=127.0.0.1
PORT=8080
ALLOWED_ORIGINS=https://game.example.com
ALLOW_NO_ORIGIN=false
```

Replace the example domain with your domain, point DNS at the host, and permit Caddy's HTTP/HTTPS certificate traffic. Use [Caddyfile.example](Caddyfile.example); its root must contain demo.html. The browser connects to `wss://game.example.com/`; `/healthz` proxies to the backend. Serve the page over HTTPS, not file://. Test certificate issuance, Origin rejection, health, reconnect, and two-client gameplay in your own environment: this example is not a claim of a tested external deployment.

Authentication is the first WebSocket frame. Never put account or room secrets in URL queries, analytics, access logs, console logs or exception reports. Disable proxy access logging unless a verified redaction policy exists. Normal backend logs omit payloads and URL queries. The optional detailed log mode captures payloads with credential-field redaction; see [Detailed logs](../README.md#detailed-logs) for its data handling and retention limits. Protect sessionStorage from XSS with trusted static content and an appropriate production CSP (the demo currently uses an inline script).

Caddy forwards WebSocket upgrades automatically. The server intentionally uses the actual socket remote IP and does not trust X-Forwarded-For. Behind this loopback proxy **all clients share the proxy-IP connection and attempt quotas**. Account for this in MAX_CONNECTIONS_PER_IP and MAX_CONNECTIONS_PER_MINUTE without removing global bounds. Do not simply trust forwarded headers: individual client quotas require a separately designed trusted-proxy policy and network boundary. Origin allowlisting is browser protection, not authentication; native clients can spoof Origin.

Keep limits finite; budget process memory for accounts, rooms, payloads and queued sends. Monitor health, resource use and rejected traffic. Accounts are memory-only, offline TTL defaults to 300000 ms; rooms disappear on last active disconnect and everything disappears on restart. A started game can reconnect an eligible peer only while another peer remains active. There is no persistence, multi-node shared state or transparent failover.

The room owner controls game state. JSON sender identity is server supplied, but raw binary relay has no authenticated sender header. Client-authoritative gameplay cannot prevent cheating or guarantee fair results; implement server-authoritative validation for competitive or valuable outcomes. TLS and quotas do not change that trust boundary.

## Optional detailed logging with systemd

For a systemd service, configure a persistent writable directory outside the release
checkout. For example, an override for `no-logic-game-server.service` can contain:

```ini
[Service]
LogsDirectory=no-logic-game-server
LogsDirectoryMode=0700
Environment=VERBOSE_LOGS=true
Environment=LOG_DIRECTORY=/var/log/no-logic-game-server
Environment=LOG_MAX_BYTES=1073741824
Environment=LOG_FILE_MAX_BYTES=16777216
```

`LogsDirectory` assigns directory ownership to the service user. Apply changes with
`systemctl daemon-reload` and restart the service when interrupting active sessions
is acceptable. The CLI writes detailed events into that directory and rotates them
automatically; do not run a second external rotator on the same files. Existing
nginx/systemd logs have their own retention policies. Set `VERBOSE_LOGS=false` and
restart to return to minimal console logging; existing diagnostic files remain.

## Shared-domain telemetry

Keep the existing `wss://game.example.com/` relay and `/healthz` routes. Run the new
telemetry service separately on `127.0.0.1:8787`, and add the `/telemetry/` prefix
to the existing TLS virtual host; strip the prefix before proxying. Do not start a
second public proxy on ports 80/443. Neither telemetry deployment nor reloads of
its service require restarting the relay. A relay update itself disconnects rooms;
check `/healthz` and schedule a restart when rooms/players are absent.

For **nginx**, add this location inside the existing HTTPS server block:

```nginx
location ^~ /telemetry/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    client_max_body_size 64k;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
    proxy_send_timeout 10s;
    access_log off;
}
```

The trailing `/` on `proxy_pass` strips `/telemetry/`. Existing WebSocket upgrade
settings remain in the existing `/` route. Validate with `nginx -t` before reloading.
For **Caddy**, add this route inside the existing domain block instead:

```caddyfile
handle_path /telemetry/* {
    reverse_proxy 127.0.0.1:8787
}
```

Validate the complete existing Caddyfile before reloading. Keep the ingest port
private and let the receiver authenticate the separate `no-logic` project key.
Set `TELEMETRY_ENABLED=true`, `TELEMETRY_URL=https://game.example.com/telemetry/v1/events`, `TELEMETRY_PROJECT=no-logic`
and the generated server write key in a root-owned environment file used by the
relay service (for example via systemd `EnvironmentFile=`). Do not put keys into
Git or command history. The user-selected SMTP recipient and scheduling belong in
the telemetry service configuration and can change without rebuilding clients.
To disable transmission without deleting the configured endpoint/key, set
`TELEMETRY_ENABLED=false` and restart the relay at an appropriate time. With this
explicit kill switch, unused malformed telemetry settings are ignored too.

Verify both `/healthz` and `/telemetry/healthz`, a test event for each configured
project, rejected wrong keys, and WebSocket connection/authentication after the
proxy reload. Missing SMTP credentials must not prevent ingest or bounded local
report generation; only enable SMTP delivery once the provider is configured.
