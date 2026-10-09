# Follow-up to the independent PR review

The user supplied the [independent review of 7abf639](https://github.com/apxapob/no_logic_game_server/pull/1#pullrequestreview-5474971833).
Its substantive verdict was **changes required, two P1 findings**. GitHub's COMMENTED
state was not approval (the publishing account also owns the PR).

Both findings were accepted. This document records implementation, lead self-checks
and test execution, not a new independent review or approval. No automatic re-review
or merge is performed.

## R1: serialized response budgets

[Original finding](https://github.com/apxapob/no_logic_game_server/pull/1#discussion_r4234221408)

- Validate the depth of the entire envelope before normalization, including extension
  fields; a deeply nested ignored field cannot escape validation and crash stringify.
- Check canonical JSON bytes, not just the incoming wire length. The reported 12,000
  `1e20` literals are rejected with `payload_too_large` before room allocation/fan-out.
- Preflight complete relay envelopes and binary payloads against
  `min(maxPayloadBytes, maxBufferedBytes - 10)` before dispatch. Oversized input is
  rejected at the sender; it does not disconnect healthy recipients.
- Check combined room gameData/metadata with reserved full-capacity player IDs, RTT
  and pagination-envelope space. Reject metadata changes atomically, preserving state.
- `getRooms` uses byte-bounded pages, keeps `data` as an array, and adds envelope
  `nextCursor`; continue with `{after: nextCursor}`. Cursor ordering survives deletion;
  pages are not a snapshot. The demo follows paced pages and fences stale continuations.
- Oversized `getPlayers` returns explicit `response_too_large`; smaller ID subsets work.
- Preserve queue-pressure protection for a genuinely accumulating transport buffer.

The previous test expecting a healthy recipient to close for a single oversized relay
encoded the wrong policy. It now asserts sender rejection and continued service for
both clients, rather than weakening the queue limit to hide the issue.

## R2: RFC control frames

[Original finding](https://github.com/apxapob/no_logic_game_server/pull/1#discussion_r4234221414)

- Disable ws autoPong. Data messages and RFC Ping/Pong share the same incoming rate
  counter, including unauthenticated connections.
- Reply to Ping manually only after checking bufferedAmount plus payload and the
  two-byte control header. Unsolicited Pong is counted but not echoed or used as RTT.
- Terminate rate/queue violators without appending a close frame to a saturated queue.

## Verification

The lead first ran two new regressions against the unchanged baseline: both failed
(serialization closed the socket; control flood did not close). After implementation:

- Windows Node 26.4.0 and Node 24.21.0: `npm run check` succeeds, **63 tests: 62 pass,
  one POSIX SIGTERM platform skip**, no failures. Includes clean `npm ci` verification.
- `npm audit` and `npm audit --omit=dev`: **0 vulnerabilities**.
- The tester repeated all **11 targeted regressions five times** on Windows. The lead
  repeated the final portable harness five times as well; every local run passed.
- Paused-reader test: at most 1,000 Ping frames of 125 bytes under default quotas.
- Separate byte-limit test: 10,000 Ping frames (1.25 MB input maximum), quota 20,000,
  output budget 512 bytes. The test corks the real server socket's writable stream
  (no mocked bufferedAmount) to deterministically hold outgoing bytes. Four 127-byte
  replies fit; the fifth terminates the offender without being queued. Observed queue
  plus framing stays within 512 bytes. This tests the byte limit independently of the
  ordinary 120-message rate limit, without an unbounded stress test.
- Portability correction: initial commit `0f8f272` passed Windows but failed this one
  Linux test because it assumed a fixed paused-reader flood necessarily fills the
  transport queue. OS TCP buffers need not reach that precondition at the same load.
  The final harness explicitly holds the real writable stream rather than increasing
  load, loosening the production limit, removing the test, or weakening its assertions.
- Two real Chromium tabs were checked by the lead with three existing rooms containing
  50 KB gameData each and 50 ms simulated latency. Matchmaking and reconnect succeeded;
  the reconnect scanned three pages (50,639 / 50,355 / 50,321 bytes), all below 65,536.
  Both players returned to the same match; browser console had no warnings/errors.
- Lead checked the diff and test logs; tester did not alter source or expected results.

Remote [PR CI for c93fd49](https://github.com/apxapob/no_logic_game_server/actions/runs/37989084433)
and its push workflow both succeeded: **Ubuntu 63/63 pass**, **Windows 62 pass / one
POSIX SIGTERM skip**, clean install/check/audit passed, zero vulnerabilities. The lead
checked actual job logs, including the portable saturated-control-queue test. Results
for later documentation-only commits are visible in the PR checks and replies.
The original verification report remains in
[hardening-verification.md](hardening-verification.md); its older 50-test counts refer
to the pre-review implementation, not this follow-up. External TLS deployment and
production capacity remain outside this local verification.
