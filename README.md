# No Logic Game Server

WebSocket rooms for client-authoritative games, with optional opaque session persistence. The server relays and stores data; it does not validate gameplay or prevent cheating.

## Persistent sessions

The CLI enables storage in `SESSION_DIRECTORY` (default `./sessions`). Use an absolute,
writable directory outside release checkouts in production. Embedded `new Server()`
instances enable storage by supplying `sessionDirectory`. `onConnected` advertises
`persistentSessions: true`; game clients request it with
`startGame: {fixedRoster:true, hostMigration:true, persistent:true, ...}`.
General requests this automatically for every new online match.

Persistent rooms survive an empty active roster. The last departure atomically writes
the room header and opaque binary state, then releases the world from RAM. Graceful
shutdown also saves active rooms. A process crash can lose changes since the last
disk save; acknowledged updates while a participant is connected reside in RAM.
The first participant returning becomes host with a new generation. Incomplete
uploads are discarded; only a complete committed state becomes visible.

Clients retain their room IDs. `getSavedRooms {ids: UUID[]}` accepts up to 20 IDs and
returns one `savedRoom {roomId,room:DTO|null}` per ID, restricted to participants.
Queries read only headers and do not retain inactive worlds. `getRooms` still lists
live rooms. DTOs for persistent games include `persistent:true` and `participants`;
`players` continues to mean currently connected members, and may be empty.
Accounts and notification registrations are persisted separately, so existing
credentials remain valid after restart and after memory-cache expiry.

The storage protocol is game-independent:

- `getSession {requestId}` returns `sessionReply` with `revision`, `generation`,
  `size`, and the opaque original `startData`.
- `getSessionChunk {requestId,revision,offset}` returns a binary frame: byte 0 is
  `3`, bytes 1–16 are the request UUID, bytes 17–20 are the big-endian byte offset,
  and the remainder is the state chunk (at most 32,000 bytes).
- The current owner calls `beginSession {requestId,revision,generation,size}`,
  then uploads binary frames with the same layout and byte 0 equal to `2`.
  Each chunk receives `sessionReply {requestId,offset}` with the next byte offset.
- `commitSession {requestId,scheduled,immediate}` accepts a complete upload only
  for the current owner, generation and revision. It replies with the next revision
  and sends `sessionUpdated {revision}` to peers. Rejected requests return
  `sessionReply {requestId,error}`. Request IDs are UUIDs; clients pace chunks and
  reload after `stale_session` or a lost acknowledgement.

Both notification fields are either null or `{eventId,at,to,title,body,translations?}`.
`at` is an absolute Unix timestamp in milliseconds (zero means now). The server knows
nothing about turns or deadlines. A commit replaces the scheduled event and retains
queued immediate deliveries. Small notification jobs live separately from worlds,
survive restart, and retry transient provider failures every 30 seconds. Delivery is
at-least-once across an interrupted provider acknowledgement; devices should coalesce
by room/event. Only a foreground device viewing that room suppresses its notification.

`SESSION_MAX_BYTES` / `sessionMaxBytes` defaults to 1 GiB of room files. When exceeded,
the oldest **last state update** among inactive rooms is removed, with its notification
jobs. Active rooms are protected. Reading a room does not refresh its age.
`MAX_SESSION_BYTES` / `maxSessionBytes` defaults to 16 MiB per opaque state; it bounds
individual transfers, not total RAM. The server never decompresses the state.

## Run

Use Node **24+** and npm. TypeScript is intentionally capped at **~6.0.3**: typescript-eslint 8.71.1 supports TypeScript <6.1, not TypeScript 7. Node types stay on major 24.

```sh
npm ci
npm run build
npm start
# Development instead of the built server:
npm run dev
# In another terminal:
npm run demo
```

Open http://127.0.0.1:8081 in two tabs (not a file URL). Move the pointer to play Pong. The owner simulates; the other player sends coalesced input. Physics uses 120 Hz fixed steps; networking is capped at 20 Hz. Waiting solo owners check matchmaking every two seconds and converge on the smallest open demo room ID when tabs start simultaneously. Reconnect prioritizes an eligible started demo room. Credentials stay in sessionStorage, never URLs or logs. Duplicated tabs use a BroadcastChannel account claim to avoid sharing a live account. Expired credentials require explicitly creating a new guest. Use separate browser profiles if BroadcastChannel is unavailable.

```sh
npm run typecheck
npm run lint
npm test                  # builds, then node --test test/*.test.cjs
npm run check             # typecheck, lint, tests
npm run benchmark         # bounded local smoke, not a capacity guarantee
npm audit
```

## Breaking authentication migration

Connect to `ws://127.0.0.1:8080/`, then **first frame**, within 5 seconds:

```js
{method:'authenticate', data:{}} // guest; optional name
// Or reconnect:
{method:'authenticate', data:{playerId:'UUID', password:'account secret'}}
```

URL credentials are rejected. Do not retain old query-based clients. New accounts receive `accountCreated {name,playerId,password}`, then `onConnected {online}`. Reconnect receives `onConnected`; missing, expired or incorrect credentials receive `wrongPassword` and close, never a new account under a supplied ID. Authentication cannot be repeated. One live socket per account: a reconnect replaces the previous socket. When replacing a still-active room socket, the server sends `onRoomEnter` after `onConnected` to restore membership/UI; clients must not start matchmaking before processing this event. Store secrets securely; Origin is not authentication.

## API

Text frames are JSON `{method, data}`. IDs are UUIDs; room DTOs use `roomId`, player DTOs use `playerId`, not `id`. Generic game payloads may be bounded JSON, including primitives/null. Room metadata is application-defined bounded JSON, not executable code. Names are 1–64 characters, passwords at most 128, chat at most 2048. Capacity is an integer 1–maxRoomPlayers; recipient arrays must be bounded, unique IDs. Size/depth validation and quotas also apply.

### Client methods (after authentication)

| Method | data |
|---|---|
| getRooms | omitted/null or `{after?:roomId}` for byte-bounded pages |
| createRoom | `{name,maxPlayers,password?:string\|null,gameData?:JSON}` |
| updateRoom | `{name?:string,maxPlayers?:number,password?:string\|null}`; owner only, before game start. Omitted fields stay unchanged; null/empty password removes it. Names must contain 1–64 characters, with non-whitespace content. Capacity cannot be below the current player count. |
| enterRoom | `{roomId,password?:string\|null}` |
| leaveRoom | omitted; revokes legacy reconnect eligibility, but preserves an original fixed-roster seat |
| changeName | new name string |
| getPlayers | IDs array, or null/omitted for online players |
| sendChatMsg | string |
| startGame | initial JSON state; owner only. Optional `fixedRoster: true` permanently reserves seats for the original participants (see below). |
| shareGameState | `{gamestate:JSON,to?:playerId[]}`; owner only |
| requestGameState | omitted; asks current owner |
| sendToRoom | JSON to active peers |
| sendTo | `{to:playerId[],msg:JSON}`; same-room active peers only |
| setRoomMeta | JSON metadata; owner only |
| Pong | exact numeric timestamp received in Ping |

By default, binary frames relay raw bytes to active room peers. **This legacy mode has no server-authenticated sender header**: applications must not treat an embedded player ID as authenticated.

Rooms created with `binaryRelay: true` use authenticated binary routing v1 instead. The room DTO confirms `binaryRelay: true`; clients must check it before using this format. This setting is fixed for the room's lifetime. A frame contains a 17-byte routing header followed by at least one opaque payload byte:

| Offset | Client to server | Server to client |
| --- | --- | --- |
| 0 | Version `1` | Version `1` |
| 1..16 | Target UUID as 16 binary bytes, or 16 zero bytes to broadcast | Authenticated sender UUID as 16 binary bytes |
| 17.. | Application payload | Identical application payload |

UUID bytes follow the hexadecimal pairs in canonical text order (network byte order, without GUID field swaps). For example, `00112233-4455-4677-8899-aabbccddeeff` becomes `00 11 22 33 44 55 46 77 88 99 aa bb cc dd ee ff`.

Only active peers in the same room receive frames; the sender is excluded. Invalid headers return `invalid_message`. Delayed frames retain the existing session/membership fencing. The server neither parses nor decompresses the payload, so applications can compress once and reuse the bytes for multiple recipients. Clients must bound decompression and validate their own protocol, room, match and host generation. Both binary modes retain the same rate, size and backpressure limits. WebSocket `permessage-deflate` remains disabled to avoid server compression work.

### Rejoining a game with a fixed roster

Starting with `{fixedRoster:true,...}` reserves seats for the authenticated accounts active at that moment. A started room is visible only to those participants and only they may re-enter, including after explicit `leaveRoom`. Vacancies are never offered to other accounts, even if they know the room ID and password. Room notifications after departure are sent only to original participants; `getRooms` applies the same restriction. Reserved accounts do not expire while this game exists. Games that omit this flag retain the existing reservation-based reconnect behavior.

In this mode the original owner is required for the game's lifetime: their departure deletes the room and releases the surviving players, without electing a new owner. Clients must handle the owner's `playerLeft`/`playerDisconnected` event by ending the game. If the same account authenticates before its old socket has timed out, the old game connection is removed first so the host can pause and restore the returning client on re-entry. The relay does not restore gameplay itself: the host transfers state to the original player using authenticated `sendTo` / `messageFromPlayer` messages. Clients decide when recovery is complete and gameplay can resume.

Clients that implement host recovery can opt in with `startGame: {fixedRoster: true, hostMigration: true, ...}`. The server then elects the first remaining active participant when the owner leaves or disconnects, preserving the original roster and reconnect permissions. For these rooms, `newRoomOwner` carries `{playerId, generation}` instead of a string; the generation increases on each transfer, and room snapshots include `hostGeneration` (initially zero). Clients must fence old-generation messages and synchronize game state and pending commands before resuming. The relay does not interpret game logic or commands; persistent games can store them as an opaque session blob. Without `persistent:true`, the room is still deleted when the last active participant leaves. Persistent rooms are written to disk instead (see Persistent sessions). Omitting `hostMigration` preserves the original owner-loss behavior.

### Server events

| Event | data |
|---|---|
| accountCreated | `{name,playerId,password}`; secret, never log |
| onConnected | `{online}` |
| wrongPassword | authentication rejected; socket closes |
| onGetRooms | room DTO array; envelope also has `nextCursor:roomId\|null` |
| roomCreated, onRoomEnter, roomUpdated | room DTO; settings updates go to all room members and lobby clients, without the password |
| roomDeleted, roomBlock | roomId |
| onGetPlayers | public player DTO array |
| playerEnter | public player DTO |
| playerLeft, playerDisconnected | playerId |
| nameChanged | `{name,playerId}` |
| newRoomOwner | ownerId; authoritative ownership transfer |
| gameStarted, newGameState | initial/shared JSON state |
| messageFromPlayer | `{from:playerId,msg:JSON}` |
| chatMsg | `{from:playerId,text:string}` |
| gameStateRequested | requesting player DTO; owner can reply with targeted shareGameState |
| onSetRoomMeta | metadata JSON |
| Ping | numeric server timestamp; echo once with Pong |
| RoomRTT | playerId → RTT milliseconds map |
| error | `{code,text}` |

Room DTO: `{roomId,ownerId,name,players,maxPlayers,hasPassword,gameData,gameStarted,rtt,metaData}`. `players` are active member IDs, never passwords. Public player DTO: `{playerId,name,rtt,roomEntryTimestamp}`; never account secrets or `roomId`. Unknown events should be ignored safely. Invalid/unknown client methods return `invalid_message`. Lifecycle codes: `in_other_room`, `already_in_room`, `no_room`, `wrong_password`, `full_room`, `not_room_owner`, `already_started`, `game_started_without_you`; quotas use `limit_exceeded`. Rate/size abuse may close the socket.

RTT only accepts an outstanding issued timestamp once. Activity/heartbeat maintenance enforces idle timeout; an arbitrary client timestamp does not establish RTT. Other traffic cannot extend the deadline for an unanswered application Ping.

### Serialized message budgets and pagination

`maxPayloadBytes` limits both raw incoming data and normalized JSON (the complete envelope,
maximum nesting depth 32). Outgoing text/binary messages must fit
`min(maxPayloadBytes, maxBufferedBytes - 10)`; the 10-byte allowance covers data-frame headers.
A small numeric literal such as `1e20` can grow when serialized, so raw byte size alone
is not sufficient. Oversized application input/relay returns `payload_too_large` to its
sender **before** state changes or fan-out. Room creation and metadata updates reserve
enough space for the combined DTO with its full `maxPlayers` membership and a page envelope.
A rejected metadata update preserves the previous value. These limits apply to stored
`gameData` and metadata together, not separately.

`getRooms` returns one page, ordered by roomId. `data` remains an array. When the response
envelope has a non-null `nextCursor`, send `getRooms` with `{after: nextCursor}` until
`nextCursor` is null. Deleted cursors still continue lexicographically; pages are not a
snapshot, so concurrent additions before the cursor may require a fresh scan. Pace requests
against the shared incoming quota. The demo automatically collects pages at a bounded rate.
An oversized `getPlayers` aggregate returns `response_too_large` without disconnecting the
reader; retry with smaller explicit ID subsets. No partial player list is silently returned.

Queued outgoing bytes are still bounded: genuine queue saturation terminates the slow
connection. RFC WebSocket control Ping/Pong share the incoming rate quota with data frames,
including before authentication. Automatic Pong is disabled; manual echo checks queued
bytes plus the two-byte control-frame header. Control Pong does not update application RTT.
Flood/queue violations terminate the offending connection without adding a close frame
behind the saturated queue.

## Runtime and configuration

CommonJS: `const {Server} = require('./dist/Server.js')`. `new Server(options)` does not listen; `await server.start()` rejects on startup failure. `server.address()` returns AddressInfo/null; `await server.stop()` is idempotent and clears resources within its deadline. Multiple instances are supported. `server.stats()` returns `{accounts,online,rooms,pendingConnections}`. `GET /healthz` returns `{status:'ok',...}` while running; other HTTP paths return 404; WebSocket path is `/`.

Options and matching environment variables (milliseconds unless noted):

| Option | Environment | Default |
|---|---|---|
| host | HOST | 127.0.0.1 |
| port | PORT | 8080 (0 allowed for tests) |
| devMode | DEV_MODE | false |
| sendDelayMs | SEND_DELAY_MS | 0 |
| maxPayloadBytes | MAX_PAYLOAD_BYTES | 65536 |
| maxBufferedBytes | MAX_BUFFERED_BYTES | 262144 |
| maxConnections | MAX_CONNECTIONS | 256 |
| maxConnectionsPerIp | MAX_CONNECTIONS_PER_IP | 32 |
| maxAccounts | MAX_ACCOUNTS | 1024 |
| maxRooms | MAX_ROOMS | 128 |
| maxRoomPlayers | MAX_ROOM_PLAYERS | 16 |
| maxMessagesPerSecond | MAX_MESSAGES_PER_SECOND | 120 |
| maxConnectionsPerMinute | MAX_CONNECTIONS_PER_MINUTE | 60 per remote IP |
| accountTtlMs | ACCOUNT_TTL_MS | 300000 |
| heartbeatIntervalMs | HEARTBEAT_INTERVAL_MS | 10000 |
| idleTimeoutMs | IDLE_TIMEOUT_MS | 50000 |
| authTimeoutMs | AUTH_TIMEOUT_MS | 5000 |
| maintenanceIntervalMs | MAINTENANCE_INTERVAL_MS | 1000 |
| shutdownTimeoutMs | SHUTDOWN_TIMEOUT_MS | 1000 |
| allowedOrigins | ALLOWED_ORIGINS (CSV) | http://127.0.0.1:8081,http://localhost:8081 |
| allowNoOrigin | ALLOW_NO_ORIGIN | true |
| logger | programmatic only | no-op (CLI uses console, or rotating files in verbose mode) |
| verboseLogs | VERBOSE_LOGS | false |
| logDirectory | LOG_DIRECTORY | ./logs |
| logMaxBytes | LOG_MAX_BYTES | 1073741824 (1 GiB total) |
| logFileMaxBytes | LOG_FILE_MAX_BYTES | 16777216 (16 MiB per file) |

`configFromEnv` is exported by `src/config.ts`. Invalid numeric/boolean values are rejected; booleans are true/false. CLI `dev` and `delay=N` remain supported; NODE_ENV is not required. Unknown browser Origins, including literal `null`, are rejected; no-Origin native clients are permitted by default.

Connection and per-IP attempt limits include raw TCP/HTTP transports, including health probes, not just authenticated WebSockets. Incomplete and keep-alive HTTP transports are also bounded by `authTimeoutMs`; reserve quota headroom for monitoring. Message rate is per connection. Delayed global/room-transition commands preserve order; queued room-scoped traffic is discarded if membership or session changes.

Offline accounts expire after TTL. Explicit-ID `getPlayers` requests can return retained offline public DTOs until expiry; no-ID requests return only online players. Disconnect during a started match may preserve reconnect eligibility **only while another member remains active**. Last active disconnect disposes the room; restarts lose all accounts and rooms. State synchronization and owner handoff are the game's responsibility.

Room membership is released when the connection closes, or by the next maintenance tick
if the socket is still closing. Cleanup does not wait for the WebSocket close handshake
to finish. Silent connections that remain open are removed by the idle/heartbeat timeout.
A late close from a replaced socket cannot remove the current session.

See [deployment](docs/deployment.md) for TLS, origin and proxy limitations. No external deployment verification is implied.

## Detailed logs

Enable `VERBOSE_LOGS=true` when starting the CLI. For example, on Linux:

```sh
VERBOSE_LOGS=true LOG_DIRECTORY=/var/log/no-logic-game-server npm start
```

The directory must be writable by the service user. The CLI writes JSON Lines to
`server-00000000000000000001.jsonl`, then successive numbered files. Each record has
an ISO UTC `time` and `event`. Connection records include `connectionId`, socket IP,
and, when known, `playerId` and `roomId`. Events cover TCP/WebSocket connections,
HTTP health requests, rejected upgrades, authentication/replacement, rooms and owner
changes, game start, expired accounts, protocol errors, shutdown and disconnects.
Server-initiated disconnects include their reason (rate limit, output buffer limit,
authentication/heartbeat timeout, replacement, etc.); WebSocket closes include the code
and peer reason.

`message` records contain `direction` (`in`/`out`), frame `type`, original byte count,
and `payload`. JSON messages contain their parsed contents; binary and RFC ping/pong
frames use Base64. `out` means handed to the socket, not acknowledged by the client;
send failures have a separate event. Delayed/discarded messages are also recorded.
Frames rejected by the WebSocket parser (for example oversized frames) produce a
connection error rather than a complete message record.

JSON keys containing password, passwd, secret, token, authorization, cookie, or API key
are replaced with `[REDACTED]`, recursively, including authentication replies and room
passwords. Invalid JSON contents are omitted because credentials cannot be safely
identified. HTTP URL queries/headers are not recorded. Other payloads, including
chat, names, game data and raw binary contents, are recorded; arbitrary secrets embedded
in strings or binary data cannot be detected automatically. Treat this directory as
private diagnostic data. New directories/files use owner-only permissions on POSIX.

`LOG_MAX_BYTES` is the total retained byte budget, including the active file and
matching log files from previous runs. Before each write, oldest files are deleted
until the new data fits. Startup also applies a lowered budget. Rotation happens
around `LOG_FILE_MAX_BYTES`; individual records are never split across files. A
record larger than that segment target gets its own larger file, within the total
budget. A record exceeding the entire budget or 8 MiB is replaced by a
`log.record_too_large` marker. Other filenames are never deleted. Use one server
process per log directory and keep that directory stable across deployments.

Writes are asynchronous and batched. The memory queue is bounded to 8 MiB; if disk
writes cannot keep up, excess records are dropped and counted by
`log.records_dropped` once the queue drains. File errors disable the sink and emit
one stderr diagnostic, without stopping gameplay. Orderly shutdown flushes pending
records; abrupt process termination/power loss can lose pending data. Extremely
small byte budgets may not even fit a diagnostic marker.

Verbose records go only to these files, avoiding an unbounded duplicate in stdout or
the system journal. With `VERBOSE_LOGS=false` (default), the existing minimal console
logging remains and no log directory is created. The file budget does not cover nginx
or system logs. For `new Server({ verboseLogs: true, logger })`, records go to the
provided callback; library users can supply the exported `RotatingFileLogger` and must
close it after stopping the server. CLI file settings are applied by `npm start`.

Read a live file with `tail -f /var/log/no-logic-game-server/server-*.jsonl`
(restart tail after rotation to follow newly created files), or inspect a specific
connection with `jq 'select(.connectionId == "CONNECTION_ID")' server-*.jsonl`.

## Analytics and error reports

The CLI can send privacy-limited HTTPS telemetry to the shared `project-telemetry`
service. It is disabled when the URL/key are absent. Set the explicit kill switch
to `false` to disable it regardless of any other telemetry configuration:

```text
TELEMETRY_ENABLED=false
TELEMETRY_URL=https://telemetry.example.com/v1/events
TELEMETRY_PROJECT=no-logic
TELEMETRY_WRITE_KEY=<dedicated-server-project-key>
TELEMETRY_RELEASE=1.0.0
TELEMETRY_INTERVAL_MS=60000
TELEMETRY_TIMEOUT_MS=5000
```

To enable, configure your receiver URL/key and set `TELEMETRY_ENABLED=true`.
This flag accepts only `true` or `false`; `true` requires both URL and key. If the
flag is absent, providing both enables telemetry. Explicit `false` discards all
unused telemetry settings, including invalid stale URLs/keys, so they cannot block
server startup and no telemetry requests are made. Use a separate project/key
from the public game client. The URL requires HTTPS
without credentials, query parameters or fragments. Interval is 1 second–1 hour;
request timeout is 100 ms–30 seconds. The write key is 24–128 URL-safe characters
(letters, digits, underscores and hyphens); project ID uses lowercase letters,
digits, underscores and hyphens (1–64 characters), release at most 64 characters.
Malformed settings fail startup. The endpoint must accept `POST` JSON
`{project, events}` and `Authorization: Bearer ...`; batches contain at most
32 events and 64 KiB.

Events include process start/stop; minute-level counts of connections,
disconnections, room creation/deletion, game starts, authentication/protocol
failures and rejected/limited traffic; current accounts, online players, rooms,
pending connections, RSS/heap memory and uptime. A random process-session UUID
changes after restart. No player names/IDs, IP addresses, room IDs, chats,
credentials, gameplay or serialized payloads are sent, even in verbose-log mode.
Internal errors include a fixed category and exception class plus file basenames
and line numbers; arbitrary exception messages, directory paths and URLs are
excluded. Local verbose logs keep their existing separate policy.

The queue is memory-only, capped at 256 events/512 KiB (plus one in-flight batch).
Old queued events are dropped on overflow; `telemetryDropped` exposes that loss.
Failures use exponential retry backoff up to five minutes; retries preserve event
IDs. Invalid/authentication-rejected batches are dropped. Error categories are
coalesced for one minute. Shutdown flushes for at most one second. A fatal-exception
monitor preserves Node's original crash behavior; fatal delivery is best effort
and is not guaranteed before process exit. Telemetry is diagnostic, not a lossless
audit log. The relay does not wait for telemetry while serving gameplay.

For an embedded server, construct `Telemetry(telemetryFromEnv())`, pass
`telemetry: (event, details) => telemetry.observe(event, details)` to `Server`, call
`telemetry.start(() => server.stats())` after startup and `await telemetry.close()`
after stopping. Diagnostic observer exceptions are isolated from the server. Raw
diagnostic callback details can contain identifiers; only the provided
`Telemetry` adapter's allowlist is safe to transmit. The existing logger is
independent and retains its previous behavior.

The receiving service controls retention, disk quota, report scheduling and SMTP
or webhook delivery. Configure the recipient (for example `reports@example.com`) on
that service, not in game or relay binaries. See [deployment](docs/deployment.md#shared-domain-telemetry)
for adding `/telemetry/` alongside the existing WebSocket service.

## Optional Android push notifications

See [push delivery](docs/push.md) for Firebase credentials, device registration,
owner-authorized room notifications, limits and the current in-memory lifetime.
