# Project hardening implementation contract

This is the shared contract for parallel work on the audit in `todo.txt`.
The lead integrates all branches and maintains todo status/PR links. One integrated PR
will be created only after tests and lead self-checks; no automatic independent review.

## Workstreams

1. Core: all `src/` implementation (server, protocol, lifecycle, configuration, logging).
2. Tooling: package/build/lint/CI configuration and scripts; updated lockfile is generated
   by the lead after the worker finishes (workers do not execute shell).
3. Client/docs: demo, README, deployment example, demo-specific tests.
4. Regression tests: black-box server tests against the API below.

Each stream uses a separate Git worktree. No worker changes todo.txt or this contract.

## Runtime API (core <-> regression tests)

- CommonJS build in `dist/`; Node >=24. Source imports have no listener/CLI side effects.
- `const { Server } = require('../dist/Server.js')`.
- `new Server(options = {})` does not listen. `await server.start()` starts HTTP/WS;
  startup failures reject. `server.address()` returns a Node AddressInfo or null.
- `await server.stop()` is idempotent, closes/terminates sockets within the configured
  deadline and clears maintenance/delay timers. Multiple instances can coexist.
- `server.stats()` returns `{ accounts, online, rooms, pendingConnections }` counts.
- `GET /healthz` returns 200 JSON `{ status: 'ok', ... }` only while running. Other paths
  return 404. WebSocket path is `/`.
- `ServerOptions` (all optional): `host`, `port`, `devMode`, `sendDelayMs`,
  `maxPayloadBytes`, `maxBufferedBytes`, `maxConnections`, `maxConnectionsPerIp`,
  `maxAccounts`, `maxRooms`, `maxRoomPlayers`, `maxMessagesPerSecond`,
  `maxConnectionsPerMinute` (per remote IP), `accountTtlMs`, `heartbeatIntervalMs`,
  `idleTimeoutMs`, `authTimeoutMs`, `maintenanceIntervalMs`, `shutdownTimeoutMs`,
  `allowedOrigins` (string[]), `allowNoOrigin` (boolean), `logger` ((text:string)=>void).
- Suggested defaults: host 127.0.0.1, port 8080, maxPayloadBytes 65536,
  maxBufferedBytes 262144, maxConnections 256, maxConnectionsPerIp 32,
  maxAccounts 1024, maxRooms 128, maxRoomPlayers 16, maxMessagesPerSecond 120,
  maxConnectionsPerMinute 60, accountTtlMs 300000, heartbeatIntervalMs 10000,
  idleTimeoutMs 50000, authTimeoutMs 5000, maintenanceIntervalMs 1000,
  shutdownTimeoutMs 1000. Port 0 is supported for isolated tests.
- Default allowedOrigins: http://127.0.0.1:8081 and http://localhost:8081;
  allowNoOrigin defaults true for native clients. Unknown browser Origins (including
  literal null) are rejected. Origin is not authentication. Never trust forwarded IP
  headers without a separate trusted-proxy policy; document shared proxy-IP limits.
- Export configFromEnv from `src/config.ts`; accept HOST, PORT, ALLOWED_ORIGINS (CSV),
  ALLOW_NO_ORIGIN (true/false), DEV_MODE, SEND_DELAY_MS and uppercase snake case
  versions of the numeric options above. Reject invalid numeric/boolean settings.
  Retain CLI `dev` and `delay=N` compatibility. NODE_ENV is not required.

## Protocol and security

- Breaking security migration: credentials must no longer be passed in the URL.
  All clients first send `{method:'authenticate',data:{name?:string,playerId?:string,
  password?:string}}` after socket open, within authTimeoutMs. An empty data object
  creates a guest account; a supplied playerId/password pair reconnects an existing
  account. Missing/expired/incorrect credentials must NOT create an account with an
  attacker-chosen ID. Query credentials are rejected and never logged.
- A new account receives accountCreated `{name,playerId,password}`, then onConnected
  `{online}`. Reconnect receives onConnected; failure receives wrongPassword and closes.
  Authentication cannot be repeated on an authenticated connection.
- Generate IDs with crypto.randomUUID and passwords with randomBytes; never log payloads,
  names, credentials, URL query, chat, metadata, or game state, even in dev mode.
- Existing room/game method names and response envelopes remain as documented in the
  original README. Add `hasPassword` to room DTO; `players` contains active members.
- Envelope/data validation uses unknown, not any. Own-method allowlist; validate names
  (1..64 chars), passwords (<=128), chat (<=2048), integer room capacity 1..maxRoomPlayers,
  UUID IDs, recipient arrays (bounded, unique), JSON payload sizes/depth. Missing optional
  room password is equivalent to null. Unknown/malformed methods return error with
  stable code `invalid_message` without killing the server. Rate/size abuse may close.
- Generic game payloads may remain arbitrary bounded JSON (including primitives/null),
  but metadata and game state contracts must be clear. No eval, no prototype-key dispatch.
- Error codes for lifecycle retain `in_other_room`, `already_in_room`, `no_room`,
  `wrong_password`, `full_room`, `not_room_owner`, `already_started`,
  `game_started_without_you`; quota error code `limit_exceeded`.
- Ping/Pong remains numeric timestamp echo. Only an outstanding issued timestamp can
  update RTT, once, with a finite nonnegative elapsed duration. Never trust a freely
  supplied client timestamp. Heartbeat timeout relies on activity/issued pings as documented.
- Binary relay is raw bytes to active peers only (no server-authenticated sender header);
  rate/size/backpressure restrictions also apply. Explain this trust boundary in README.

## Lifecycle and resources

- Reject creation before allocation when already in a room / quotas exceeded.
- One current socket per account: replace old connection, fence old message/close/error
  and delayed callbacks by socket identity; old close never disconnects the new session.
- Separate active room members from reconnect eligibility. Explicit leave revokes room
  eligibility; disconnect during started game may retain eligibility while other members
  are active. Active room membership always agrees with Player.roomId.
- Cannot enter/reconnect any room while active in another; no cross-room JSON/binary,
  targeted sends, owner election, or state requests. When no active members remain,
  dispose the room. Last-peer disconnect therefore ends a match (document this).
- Set roomId/roomEntryTimestamp before playerEnter/onRoomEnter. Host transfers only to
  an active member. Dispose removes membership/reservations and allocated resources.
- Offline accounts expire after accountTtlMs, with bounded account/IP maps; remove their
  reconnect reservations as needed. getPlayers without IDs returns online players only;
  explicit IDs may expose retained offline public DTOs, never secrets. Sort timestamps
  ascending, null last, playerId as deterministic tie-breaker.
- Bound connections including pending-auth sockets, per-IP connection attempts, accounts,
  rooms, incoming rate/size, queued outgoing bytes, and delayed messages. Check readyState
  before send; handle async send errors without process crashes. Delays cannot re-route a
  message into a new room/session; no queued actions after shutdown.
- Use direct lookups for getPlayers subsets, online/lobby indexes or equivalently bounded
  active traversal; serialize each broadcast once. Prefer one server maintenance timer
  over per-room/per-player timers while keeping implementation simple.

## Tooling and tests

- Node 24 baseline with @types/node 24.19.2 (not newer major types than runtime).
- Registry snapshot: ws 8.22.0; ESLint 10.12.0; @eslint/js 10.0.1;
  typescript-eslint 8.71.1 supports TypeScript <6.1; therefore TypeScript ~6.0.3,
  NOT incompatible latest TypeScript 7.0.2. @types/ws 8.18.2; tsx 4.23.15;
  globals 17.13.0. Replace ts-node with tsx for dev. Document intentional major caps.
- npm scripts: build (clean dist then tsc), start (node dist/index.js), dev (tsx source),
  typecheck, lint, test (build then `node --test test/*.test.cjs`), check (typecheck,
  lint, test), demo (local static demo server on 127.0.0.1:8081), benchmark (bounded smoke).
- Test authoring in CommonJS `test/*.test.cjs`, node:test/assert, real ws clients using
  ephemeral loopback ports. Helpers are local to test ownership; no external test runner.
- Build ES2022/Node16 CommonJS, strict, no DOM lib. No stale compiled files tracked in Git.
  Lead removes tracked dist/, tslint.json and unused Lobby.ts after integration if needed.
- CI on Linux/Windows, Node24; npm ci, npm run check, npm audit. No deploy/publish.
- Provide lightweight reproducible benchmark with cleanup and honest latency/throughput
  figures, no arbitrary performance promises. Lead compares where meaningful.
- Demo: authenticate on open, handle protocol IDs/ownership/heartbeat/reconnect/errors,
  avoid logging secrets, host-authoritative game state, fixed-step or delta-time physics,
  network rate capped independently of requestAnimationFrame, coalesce pointer input.
  Serve demo over localhost HTTP; WSS deployment instructions and migration notes required.
- Final integrated checks include clean npm ci, build/lint/tests/audit, demo two-client
  smoke, resource/limit/lifecycle negative tests, and graceful shutdown/startup failures.
