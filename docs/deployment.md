# Deployment: Rust relay on Linux

This guide describes the Rust executable in this branch. Examples use generic paths
and domains; adapt them to the existing host. They are not a record of the currently
installed production revision. Keep the existing public WebSocket URL when replacing
Node: clients use the same protocol and session files.

## Build and verify a release

Build on Linux with the deployment host's architecture and a compatible libc, or
use a matching Linux build environment. Do not copy the Windows `.exe` to a VPS.
CI uses Rust 1.96.0. Node 24+ and npm are needed for the optional JavaScript test clients;
the deployed Rust binary runs without Node, npm or Cargo.

```sh
rustup toolchain install 1.96.0 --profile minimal --component rustfmt,clippy
rustup default 1.96.0
npm --prefix tools ci
npm --prefix tools run check
cargo build --release --locked
```

Use a clean checkout of the intended commit. Install the binary into a new release
directory; keep the previous release for rollback:

```sh
revision=$(git rev-parse HEAD)
release=/opt/no-logic-game-server/releases/$revision
sudo install -d -m 0755 "$release"
sudo install -m 0755 target/release/no-logic-game-server "$release/no-logic-game-server"
git rev-parse HEAD | sudo tee "$release/REVISION" >/dev/null
sha256sum "$release/no-logic-game-server"
```

Do not overwrite an executable in an active release. `current` below is a symlink
to the selected release; session data and logs are outside it.

## Service and environment

Create a dedicated unprivileged system account named `no-logic`, without interactive
login. Keep releases root-owned and readable/executable by that account. Create
`/etc/no-logic-game-server.env`, owned by root with mode `0600`. systemd reads it
before switching to the service user. Example values:

```ini
HOST=127.0.0.1
PORT=8080
ALLOWED_ORIGINS=https://game.example.com
ALLOW_NO_ORIGIN=true
SESSION_DIRECTORY=/var/lib/no-logic-game-server/sessions
SESSION_MAX_BYTES=1073741824
MAX_SESSION_BYTES=16777216
MAX_CONNECTIONS=256
MAX_CONNECTIONS_PER_IP=256
MAX_CONNECTIONS_PER_MINUTE=1024
MAX_ACCOUNTS=1024
MAX_ROOMS=128
TOKIO_WORKER_THREADS=1
SHUTDOWN_TIMEOUT_MS=5000
VERBOSE_LOGS=false
LOG_DIRECTORY=/var/log/no-logic-game-server
FCM_ENABLED=false
TELEMETRY_ENABLED=false
```

These quotas are example settings, not measured capacity. The per-IP values account
for all proxied clients sharing the proxy's IP. Preserve deployment-specific limits
when upgrading an existing installation. `ALLOW_NO_ORIGIN=true` permits native
clients that omit Origin, including Unity transports; browser requests that supply
Origin must still match `ALLOWED_ORIGINS`. Use `false` only if every supported client
sends an allowed Origin. Keep `RELAY_TEST_CONTROL` and `RELAY_TEST_PUSH_URL` **unset**:
they enable test-only controls, not production administration.

Install `/etc/systemd/system/no-logic-game-server.service`:

```ini
[Unit]
Description=No Logic Game Server (Rust)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=no-logic
Group=no-logic
WorkingDirectory=/opt/no-logic-game-server/current
ExecStart=/opt/no-logic-game-server/current/no-logic-game-server
EnvironmentFile=/etc/no-logic-game-server.env
StateDirectory=no-logic-game-server
StateDirectoryMode=0700
LogsDirectory=no-logic-game-server
LogsDirectoryMode=0700
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=60
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

For an existing service, preserve its user, writable directories, environment and
proxy routes; adapt `ExecStart` instead of replacing those settings blindly. Rust
handles SIGTERM and saves active worlds during graceful shutdown. `TimeoutStopSec`
must allow the final disk writes as well as connection/background-task shutdown;
`SHUTDOWN_TIMEOUT_MS` alone is not a deadline for all storage work.

## Activate, verify and roll back

Before switching an existing installation, inspect `/healthz` and wait for
`online=0`, `rooms=0`, and `pendingConnections=0`, or schedule an agreed interruption.
Record the old `current` target (`readlink -f`) and service definition. Stop the old
service gracefully, verify it stopped successfully, then back up the complete
session directory while no process is writing to it. Do not run Node and Rust
against the same session directory simultaneously.

After preparing the release above and stopping any previous instance:

```sh
sudo ln -sfn "$release" /opt/no-logic-game-server/current.next
sudo mv -Tf /opt/no-logic-game-server/current.next /opt/no-logic-game-server/current
sudo systemctl daemon-reload
sudo systemctl enable --now no-logic-game-server
curl --fail http://127.0.0.1:8080/healthz
sudo systemctl show no-logic-game-server -p ActiveState -p SubState -p NRestarts -p MainPID
sudo journalctl -u no-logic-game-server -n 50 --no-pager
```

Check that `current/REVISION` and the binary checksum match the selected release.
Verify public HTTPS `/healthz`, WSS authentication, room creation/join, bidirectional
messages, reconnect and persistent-session recovery with test clients. Check the
journal and that `NRestarts` is not increasing. HTTP health alone does not verify
the WebSocket route or client compatibility.

For rollback, stop Rust gracefully, atomically point `current` back to the recorded
release and start the service. If the prior release is Node, restore its original
`ExecStart`/unit as well: a Node release does not contain the Rust executable.
Run `systemctl daemon-reload` after unit changes and repeat the checks above.
The Node implementation is retired from this checkout. Rollback to a pre-migration
Node release requires Node 24+, installed dependencies and built `dist/` from its
retained checkout (`npm ci`, `npm run build`; direct entrypoint `node dist/index.js`).
Both implementations use the existing session format. Preserve the pre-update backup;
restoring it intentionally discards changes made since that backup.

## TLS and client access

Replace the example domain with your domain, point DNS at the host, and permit Caddy's HTTP/HTTPS certificate traffic. Use [Caddyfile.example](Caddyfile.example); its static root must contain `demo.html` if you serve the optional demo; a relay-only deployment needs only the WebSocket and health routes. The browser connects to `wss://game.example.com/`; `/healthz` proxies to the backend. Serve the page over HTTPS, not file://. Test certificate issuance, Origin rejection, health, reconnect, and two-client gameplay in your own environment: this example is not a claim of a tested external deployment.

Authentication is the first WebSocket frame. Never put account or room secrets in URL queries, analytics, access logs, console logs or exception reports. Disable proxy access logging unless a verified redaction policy exists. Normal backend logs omit payloads and URL queries. The optional detailed log mode captures payloads with credential-field redaction; see [Detailed logs](../README.md#detailed-logs) for its data handling and retention limits. Protect sessionStorage from XSS with trusted static content and an appropriate production CSP (the demo currently uses an inline script).

Caddy forwards WebSocket upgrades automatically. The server intentionally uses the actual socket remote IP and does not trust X-Forwarded-For. Behind this loopback proxy **all clients share the proxy-IP connection and attempt quotas**. Account for this in MAX_CONNECTIONS_PER_IP and MAX_CONNECTIONS_PER_MINUTE without removing global bounds. Do not simply trust forwarded headers: individual client quotas require a separately designed trusted-proxy policy and network boundary. Origin allowlisting is browser protection, not authentication; native clients can spoof Origin.

Keep limits finite; budget process memory for accounts, rooms, payloads and queued sends. Monitor health, resource use and rejected traffic. Without session storage, accounts expire from memory after the offline TTL (300000 ms by default) and rooms disappear on last active disconnect. With storage enabled, accounts survive restart and persistent games can resume without active peers. This remains a single-node service without transparent failover.

The room owner controls game state. JSON sender identity is server supplied. Legacy raw binary relay has no authenticated sender header; opt-in binary v1 routing supplies an authenticated sender ID and validates room membership. It still treats the game payload as opaque bytes. Client-authoritative gameplay cannot prevent cheating or guarantee fair results; implement server-authoritative validation for competitive or valuable outcomes. TLS and quotas do not change that trust boundary.

## Persistent data and memory limits

The service example above provides a stable writable session directory. Rust enables
`./sessions` by default; use an absolute production path. Set `SESSION_DIRECTORY=`
explicitly to disable persistence for a disposable instance.

`SESSION_MAX_BYTES` is a disk quota for stored room files, not a process RAM limit;
active worlds are protected from eviction. `MAX_SESSION_BYTES` limits one state or
upload. At 128 rooms and 16 MiB per state, states alone can occupy 2 GiB and unfinished
uploads can add another 2 GiB. Budget these limits together with connection buffers,
accounts and OS/proxy memory. Persistent notification jobs can also accumulate
when delivery is unavailable; there is no global backlog/RAM budget.

Tokio handles sockets asynchronously; ordered room operations and persistence run
on one state thread. `TOKIO_WORKER_THREADS` adds network workers, not parallel room
state processing. More workers are not automatically faster on a small VPS.

Back up this directory together: room files, account credentials and notification
jobs belong to the same service. Keep it outside release/rollback directories.
Graceful service stops flush active worlds; forced termination can lose updates
made while a room was active. No game rules execute on this service.

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

When using the environment file above, put these `LOG_*` and `VERBOSE_LOGS` values
in that file instead of duplicating them in an override; `EnvironmentFile` values
take precedence over `Environment`. `LogsDirectory` assigns directory ownership
to the service user. Apply changes with
`systemctl daemon-reload` and restart the service when interrupting active sessions
is acceptable. The CLI writes detailed events into that directory and rotates them
automatically; do not run a second external rotator on the same files. Existing
nginx/systemd logs have their own retention policies. Set `VERBOSE_LOGS=false` and
restart to return to minimal console logging; existing diagnostic files remain.

## Optional push delivery

See [push delivery](push.md) for device registration and notification behavior.
Rust uses Application Default Credentials via `gcp_auth` and the FCM HTTP v1 API;
Set `FCM_ENABLED=true` and
`GOOGLE_APPLICATION_CREDENTIALS` to a service-account file readable by the service
user, outside releases and Git. Supply `GOOGLE_CLOUD_PROJECT` if project discovery
is unavailable. Validate real device delivery separately from mock-provider tests.

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
and `TELEMETRY_WRITE_KEY` with the generated server write key in a root-owned environment file used by the
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
