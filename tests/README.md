# Test coverage

Run `cargo test --all-targets --locked`. Cargo supplies the exact executable path
to the integration harness, including release builds and custom target directories.
`RUST_SERVER_BINARY` deliberately overrides it when checking a retained release.
No Node runtime or npm packages are used.

The former JavaScript process suite was consolidated into Rust integration tests:

| Former area | Current coverage |
|---|---|
| `server`, authentication and public DTOs | `cases/auth.rs` |
| `room-settings`, `room-lifecycle`, `reconnection` | `cases/rooms.rs`, `cases/limits.rs` |
| `binary-relay`, `rust-parity` | `cases/rooms.rs`, `cases/sessions.rs`, `wire.rs` |
| `review-regressions`, quotas, heartbeat, delayed work | `cases/limits.rs`, `cases/rooms.rs` |
| `sessions`, storage failures, restart/crash recovery, 200 sleeping worlds | `cases/sessions.rs` |
| `push`, durable notifications, localization, provider failure/retry | `cases/push.rs` |
| `logging`, dev-mode privacy, broken sink, CLI rotation | `cases/logging.rs`, `tools.rs` |
| CLI config and SIGTERM | `config.rs`, `tools.rs` (SIGTERM on Unix, stdin stop on Windows) |
| Ten demo regressions | `browser/demo-cases.js`, executed by `browser.rs` in Edge/Chrome |

The browser cases retain the same fake clocks, frame inputs and assertions; a
browser `Function` scope replaces Node's `vm` sandbox. They test matchmaking,
authentication, reconnect, paging, heartbeat and separation of rendering/network
ticks. This is not a visual screenshot test. `CHROME_BIN` overrides browser detection;
missing browsers fail explicitly rather than silently skipping the cases.

`tools.rs` additionally checks HTTP allowlisting, private-file rejection, remote
protocol smoke, network RTT and stepped load against an isolated local server.
Runtime unit tests remain next to their modules under `rust/`.

Test helpers use bounded socket channels and bounded waits. Tests needing snapshots
start an isolated server with `RELAY_TEST_CONTROL`; performance and memory tools
explicitly remove that variable and use production mode. Temporary directories and
child processes are cleaned up when their owning guards drop.

The old server-side wrapper for General's external Vite/Playwright test suite was
removed. End-to-end General turn/world equality remains a client-project concern;
protocol smoke here does not replace or claim that gameplay coverage.

Test function counts differ because related cases share setups. Preserve the
scenarios and assertions above when refactoring rather than matching a historical
function count. Memory churn and throughput reports are generated on demand under
ignored `test-results/`, not committed as test fixtures.
