# No Logic Game Server

Bounded, in-memory WebSocket rooms for client-authoritative games. The server relays data; it does not validate gameplay or prevent cheating.

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
| getRooms | omitted |
| createRoom | `{name,maxPlayers,password?:string\|null,gameData?:JSON}` |
| enterRoom | `{roomId,password?:string\|null}` |
| leaveRoom | omitted; revokes reconnect eligibility |
| changeName | new name string |
| getPlayers | IDs array, or null/omitted for online players |
| sendChatMsg | string |
| startGame | initial JSON state; owner only |
| shareGameState | `{gamestate:JSON,to?:playerId[]}`; owner only |
| requestGameState | omitted; asks current owner |
| sendToRoom | JSON to active peers |
| sendTo | `{to:playerId[],msg:JSON}`; same-room active peers only |
| setRoomMeta | JSON metadata; owner only |
| Pong | exact numeric timestamp received in Ping |

Binary frames relay raw bytes to active room peers. **No server-authenticated sender header exists**: applications must not treat an embedded player ID as authenticated. Binary traffic has the same rate, size and backpressure limits.

### Server events

| Event | data |
|---|---|
| accountCreated | `{name,playerId,password}`; secret, never log |
| onConnected | `{online}` |
| wrongPassword | authentication rejected; socket closes |
| onGetRooms | room DTO array |
| roomCreated, onRoomEnter | room DTO |
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

RTT only accepts an outstanding issued timestamp once. Activity/heartbeat maintenance enforces idle timeout; an arbitrary client timestamp does not establish RTT.

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
| logger | programmatic only | no-op (CLI uses console) |

`configFromEnv` is exported by `src/config.ts`. Invalid numeric/boolean values are rejected; booleans are true/false. CLI `dev` and `delay=N` remain supported; NODE_ENV is not required. Unknown browser Origins, including literal `null`, are rejected; no-Origin native clients are permitted by default.

Connection and per-IP attempt limits include raw TCP/HTTP transports, including health probes, not just authenticated WebSockets. Incomplete and keep-alive HTTP transports are also bounded by `authTimeoutMs`; reserve quota headroom for monitoring. Message rate is per connection. Delayed global/room-transition commands preserve order; queued room-scoped traffic is discarded if membership or session changes.

Offline accounts expire after TTL. Explicit-ID `getPlayers` requests can return retained offline public DTOs until expiry; no-ID requests return only online players. Disconnect during a started match may preserve reconnect eligibility **only while another member remains active**. Last active disconnect disposes the room; restarts lose all accounts and rooms. State synchronization and owner handoff are the game's responsibility.

See [deployment](docs/deployment.md) for TLS, origin and proxy limitations. No external deployment verification is implied.
