# Hardening verification

Verification of the integrated change, not an independent review or approval.
Implementation was split across four worktrees (core, tooling, client/docs, regression
tests), then integrated and self-checked by the lead. A tester executed final checks.
Original findings: [audit baseline](audit-baseline.txt). Completion tracking: [todo](../todo.txt).

## Automated checks

Windows environment: Node 26.4.0 / npm 11.17.0. Supported baseline additionally tested
with Node 24.21.0 obtained through npm's temporary executable cache.

| Check | Result |
| --- | --- |
| `npm ci` | Clean install succeeds |
| `npm run check` | Strict typecheck, ESLint, clean build, tests pass |
| `node --test "test/*.test.cjs"` | 50 tests: 49 pass, 1 platform skip |
| Same tests repeated three times | 49 pass / 1 skip each; no failures |
| `npm exec --yes --package=node@24 --call "node --version && npm run check"` | Same result on Node 24.21.0 |
| `npm audit` | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm outdated` | Only intentional major caps: TypeScript 6.0.3 and @types/node 24.19.2 |
| Production-only temporary install | `npm ci --omit=dev` installs ws without TypeScript; compiled server starts |
| Demo static server | GET / and /demo.html: 200; private repo paths: 404; POST: 405; HEAD: no body |

The skipped test exercises the POSIX SIGTERM handler: Windows child.kill does not
provide the equivalent signal behavior. Linux/Windows Node 24 CI is configured;
remote CI status is reported on the PR rather than inferred from local checks.

Regressions cover guest/reconnect authentication, URL credential and Origin rejection,
session replacement and active-room restoration, permissions, explicit leave versus
network disconnect, host transfer, cross-room JSON/targeted/binary isolation, no ghost
rooms, TTL, timestamps/sorting, malformed/deep JSON, protocol allowlist, connection/IP/
message/payload/queue limits, RTT forgery/replay, delayed membership/session fences,
startup cancellation/bind failure, raw TCP/partial HTTP cleanup and idempotent shutdown.

## Browser verification by the lead

Two real Chromium tabs through Playwright, actual WebSocket server on loopback, with
50 ms simulated inbound latency:

- Both players enter the same match; ball moves and remote paddle input reaches owner.
- Reconnect of each player restores the same match; disconnecting the owner transfers
  ownership, and the returning former owner becomes a peer.
- Heartbeat remains functional beyond 90 seconds (longer than the default idle timeout).
- Owner emits 22 game-state updates in 1102 ms, consistent with the separate 20 Hz tick.
- Duplicating a tab with cloned sessionStorage creates a separate account via
  BroadcastChannel; the original match remains connected and active.
- No browser console errors or warnings observed. Test tabs and server fixture stopped.

VM tests additionally cover simultaneous solo-room creation and deterministic
matchmaking convergence, protocol fields, ownership, safe unknown events and timing.

## Bounded performance smoke

`npm run benchmark` measures authenticated getPlayers round trips on loopback, with
25 ms pacing per client. These numbers are not throughput limits, comparisons against
the old server, or production capacity guarantees.

| Clients | Duration | Requests | Requests/s | p50 latency | p95 latency |
| --- | --- | --- | --- | --- | --- |
| 8 | 2000 ms | 504 | 252 | 0.42 ms | 1.30 ms |
| 32 | 2009 ms | 2048 | 1019 | 1.56 ms | 2.68 ms |

Algorithmic changes remove historical-account lobby scans, use direct subset lookups,
serialize broadcasts once, and replace per-room/per-player intervals with one bounded
maintenance scheduler. Delay timers remain bounded per connection.

## Boundaries

- No destructive CVE exploit, unbounded stress/OOM test, or production deployment.
- Caddy/WSS configuration is an example: domain, certificates, Origin configuration,
  proxy limits and CSP must be verified in the actual deployment environment.
- Proxy clients share socket-IP quotas unless a separately secured trusted-proxy policy
  is introduced. Health probes also consume TCP admission quotas.
- Persistence, anti-cheat, multi-node state and binary sender authentication are not
  promised by this client-authoritative relay; limitations are documented in README.
- Authentication is a breaking migration: first WebSocket authenticate message replaces
  URL credentials. Existing query-auth clients must be updated.
