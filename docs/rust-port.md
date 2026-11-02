# Rust relay compatibility experiment

The Rust executable is an alternative implementation on `codex/rust-server-parity`.
The TypeScript server remains available as the reference implementation and rollback
target. No client project is modified. The Rust relay was deployed on the existing
VPS on 2026-11-02 (Moscow time), with the Node release retained for rollback.
See the [VPS comparison](benchmarks/vps-rust-20261102.md) for the deployment,
repeated historical stress test, and read-buffer measurements.
The [pre-merge review](rust-premerge-review.md) records subsequent fixes,
local before/after measurements and connection/session cleanup checks.

## Build and run

```sh
npm ci
npm run build:rust
npm run start:rust
# Or run target/release/no-logic-game-server directly (.exe on Windows).
```

The binary uses the existing environment variables, `/healthz`, first-frame
authentication, JSON methods/DTOs/errors, raw binary relay and authenticated v1
binary routing. It supports `dev` and `delay=N` arguments. Compression remains a
client responsibility. Existing session-directory files need no conversion.
FCM uses Application Default Credentials and the FCM HTTP v1 API; the existing
`FCM_ENABLED` switch and `GOOGLE_APPLICATION_CREDENTIALS` remain applicable.

For a local non-persistent experiment set `SESSION_DIRECTORY` to an empty string.
For persistent games keep the directory outside the release checkout. Run only one
server against a session directory, as with the Node implementation. Stop the old
process gracefully before switching binaries. Reverting to Node uses the same
directory and credentials. A hard kill still loses active changes since the last
disk save; this is intentionally unchanged.

## Concurrency and resource limits

Tokio handles sockets independently. A dedicated `relay-state` thread owns ordered
state transitions, including disk operations, behind a bounded 256-command queue.
Health, push and telemetry tasks query that same owner asynchronously; they do not
take a blocking mutex around the server. A slow state operation still delays queued
commands, but does not hold the Tokio executor thread.
Each connection has a byte-bounded output queue; saturation aborts the connection,
including when its socket writer is blocked. Queued room messages retain their
membership generation and cannot migrate into a new room after reconnect.

The default is one Tokio network worker plus the state thread, with separate
blocking/logging workers as needed. `TOKIO_WORKER_THREADS` can increase network
workers. More workers increased CPU overhead in this Windows loopback experiment;
the default follows the measurement rather than the machine's logical CPU count.

**Room state transitions are still serialized.** This port does not yet implement
parallel room simulation or promise linear scaling with CPU cores. Storage no
longer blocks the socket runtime, but a slow storage operation can still delay
protocol commands waiting on the state worker. Large game states consume their
actual byte size in either implementation; language changes do not compress them.
Session limits are per room, not a global RAM budget. `SESSION_MAX_BYTES` limits
stored room files and is not a process memory limit. Pending persistent push jobs
also need a separate backlog policy if delivery remains unavailable for a long time.

## Compatibility checks

```sh
npm run check        # Reference Node typecheck, lint and tests
npm run check:rust   # Rust formatting, clippy, native tests and adapted suite
node scripts/general-client-smoke.mjs
node scripts/memory-churn.cjs # Local release binary; repeated connect/save/disconnect
```

The JS harness uses `RELAY_BACKEND=rust` to launch a Rust process instead of the
in-process Node server. A stdin/stdout control adapter exposes snapshots and mock
push callbacks solely when `RELAY_TEST_CONTROL=1`; it is not a network endpoint.
The adapter synchronizes snapshots before assertions that inspect server state.
Do not enable this diagnostic switch in production or benchmarks.

The shared suite includes both socket tests and reference JS-only unit/CLI tests;
its total is **not** a count of Rust-only tests. Two Node `ws` monkeypatch tests are
skipped for Rust and replaced by native output-budget and rate-limit tests. The
POSIX SIGTERM test is skipped on Windows. Rust hard-kill recovery runs the actual
Rust executable. Additional tests check Node → Rust → Node persistence and numeric
JSON forms from non-JavaScript clients.

Client coverage:

| Client | Verified contract / execution |
| --- | --- |
| General-recovery | Authenticated binary v1, compressed opaque payloads, persistent sessions, host migration and rejoin. Three unchanged browser clients completed three turns, host loss and rejoin with identical canonical worlds and zero client errors. |
| VampireTowers | Existing `RelaySocket` JSON authentication/lobby messages and legacy `RelayTunnel` `0xF8` batches, including .NET GUID byte order, remain unchanged. Wire tests pass; Unity Editor/device playthrough not run. |
| ForTheWTF | Existing lobby JSON and `WebSocketRelayNetworkInterface` legacy `0xF7`/`0xF8` frames remain opaque and byte-identical. Wire tests pass; Unity Editor/device playthrough not run. |

The browser smoke runner locates the sibling General-recovery project by default;
override `GENERAL_GAME_DIRECTORY` if necessary. It starts its own local dev server
and Rust relay and stops both. Detailed artifacts, including session/account files,
are ignored under `test-results/`. Do not publish that directory.

FCM delivery is tested through a local mock provider (localization, foreground
suppression, invalid tokens, deduplication, retry, restart and cancellation).
Live FCM credentials/delivery have not been exercised. The deployed Linux binary
passed the adapted suite and public WSS smoke checks; CI checks the implementations
on Windows and Ubuntu. Telemetry retains
the collector envelope and uses platform `rust-<os>`; it reports process RSS rather
than inventing a JavaScript `heapUsedBytes` metric. Native tests cover queue bounds,
retry IDs, log rotation/redaction and storage corruption/eviction.

## Reproducing measurements

```sh
npm run benchmark:compare
```

`COMPARE_ROUNDS` (default 3), `COMPARE_DURATION_MS` (5000), and `COMPARE_PAIRS` (16)
control the experiment. It alternates implementation order, warms each process for
one second, then runs 16 independent two-peer rooms with 512-byte and 32,000-byte
authenticated binary frames. Each measured round trip traverses the relay twice.
The server and load generator are separate processes. CPU and resident memory are
sampled from the server process; results include idle and peak memory. Storage,
push, verbose logging and telemetry are disabled equally for both servers.

`COMPARE_SIZES` overrides frame sizes (comma-separated bytes). For comparisons of
native variants, `COMPARE_NATIVE_BINARIES` accepts a JSON object mapping labels to
absolute executable paths; `COMPARE_OUTPUT` overrides the output JSON path.
New runs write to ignored `test-results/rust-comparison.json` by default; the
committed benchmark reports below are historical measurements, not generated output.
`COMPARE_PROTOCOL=json` exercises JSON relay instead; the default is `binary`.
JSON sizes are approximate input targets (padding plus timestamp/envelope), whereas
binary sizes specify the exact input frame length.

The cleanup runner defaults to 30 cycles of 64 clients with 128 KiB committed state
and a 256 KiB unfinished upload per room. `CHURN_CYCLES`, `CHURN_CLIENTS` (multiple
of four), `CHURN_STATE_BYTES`, `CHURN_DELAY_MS`, `CHURN_OUTPUT`, and
`RUST_SERVER_BINARY` override these settings. It creates a private temporary session
directory alongside the report, only connects to its own loopback server, and
requires all live health counters to return to zero after each cycle. Resource
samples include RSS, private committed bytes on Windows (anonymous RSS on Linux),
handles/file descriptors and threads. CI runs a short lifecycle scenario on both
platforms; it does not assert a machine-dependent RSS threshold.

Raw repetitions and machine details are in [benchmarks/rust-comparison.json](benchmarks/rust-comparison.json).
This is a Windows loopback microbenchmark, not a maximum-player estimate or a
measurement of Internet ping. The single Node load generator and local networking
can limit throughput. It does not benchmark concurrent disk writes, live push,
long-running memory retention, WAN conditions or production Linux scheduling.

### Measured results (2026-11-01)

Medians of three repetitions, 32 clients / 16 rooms. Reference Node source:
`6e7d10c8bebb3bbcf5c156ed71589dcc1f93b139`. Values below are per **round trip**
(two relay hops), not single-hop delivery latency.

| Metric | 512 bytes: Node | 512 bytes: Rust | 32,000 bytes: Node | 32,000 bytes: Rust |
| --- | ---: | ---: | ---: | ---: |
| Round trips / second | 28,334 | 26,390 | 7,783 | 7,609 |
| CPU ms / 1,000 round trips | 34.48 | 42.10 | 135.21 | 86.85 |
| Resident memory under load, MiB | 72.16 | 12.53 | 83.57 | 13.67 |
| Idle resident memory, MiB | 58.09 | 6.98 | 58.16 | 6.96 |

Memory fell by about 83–84% (5.8–6.1× less under load). Small-frame throughput
fell 6.9%, with 22.1% more CPU per operation. Large-frame throughput was similar
(median −2.2%, with substantial variation between repetitions), with 35.8% less
CPU per operation. These measurements **do not establish a general speedup**.
They establish a substantial memory saving and workload-dependent CPU efficiency.

Validation at initial port completion: the reference suite passed 128 tests (4 skips); the
adapted suite passed 129 tests (3 skips); 8 native Rust tests passed. Formatting,
Clippy with warnings denied, TypeScript checking and ESLint passed. See the coverage
qualification above: shared-suite totals include reference JS-only unit tests.
