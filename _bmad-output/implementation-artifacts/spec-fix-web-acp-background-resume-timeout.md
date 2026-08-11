---
title: 'Fix web ACP background-resume transport timeout'
type: 'bugfix'
created: '2026-08-11'
status: 'done'
review_loop_iteration: 0
baseline_commit: '81391378b34b098e1aa14a60ea79f835af70bb51'
context:
  - 'docs/project-context.md'
  - 'docs/architecture.md'
  - 'docs/api-contracts.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Cloudflare-served Termul browser tab can return from background with a stale ACP WebSocket, time out an ordinary request such as `list_persisted_sessions`, and surface `AcpTransportError` while the host-owned agent and transcript remain alive. The current relay can also block all heartbeat/history traffic behind a long `send_prompt`, then let watchdog-first termination bypass subscription cleanup.

**Approach:** Keep logical ACP sessions independent from individual sockets: let accepted prompt work continue without blocking the connection read loop, run disconnect cleanup exactly once whichever socket half exits, validate a socket immediately when the browser resumes, and recover history after reconnection without emitting an unhandled rejection.

## Boundaries & Constraints

**Always:** Preserve host-owned history, turn IDs, cursor replay, one active turn per session, desktop/shared-live parity, and the `serve_router` no-kill invariant. Use existing reconnect UI and structured logging; never log prompt content or credentials.

**Ask First:** Any WS envelope change, persistence schema migration, automatic prompt resend, agent restart, or change to the configured 20s ping / 75s watchdog policy.

**Never:** Do not solve this by merely increasing timeouts, storing ACP history authority in browser storage, cancelling an accepted agent turn on browser disconnect, or masking a genuine agent crash as a reconnect.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Long agent turn | `send_prompt` runs beyond watchdog window | Same socket still processes heartbeat and history requests; turn completes once | Reply delivery to a disconnected socket is best-effort |
| Chrome background then return | Socket reports OPEN but round-trip path is stale | Short health validation fails, socket is replaced, sessions resubscribe by cursor | Keep reconnect indicator active; retry with backoff |
| Watchdog/write half exits first | Connection owns session subscriptions | All clients are unregistered once; permission/question disconnect policy runs | Cleanup logs session count, not sensitive payloads |
| History refresh during stale socket | `list_persisted_sessions` fails transiently | Existing sidebar data remains; refresh retries after transport recovery | Log a warning; no unhandled rejection or destructive empty replacement |

</frozen-after-approval>

## Code Map

- `src-tauri/src/web/ws.rs:498-724` -- `run_relay`; long handlers run inline and cleanup currently lives only in the read task, so watchdog-first completion aborts it before cleanup.
- `src-tauri/src/web/ws.rs:2565-2707` -- `handle_send_prompt`; accepted prompt persistence and turn-watermark lifecycle must survive socket loss.
- `src-tauri/src/web/permissions.rs:1128-1240` -- `TurnWatermark`; reuse claim, completion, and exact-claim release semantics.
- `src-tauri/src/web/sink.rs:553-738` -- cursor replay/snapshot authority; preserve behavior and unregister clients through its APIs.
- `src/renderer/lib/acp-transport.ts:949-1208` -- socket open, lifecycle recovery, heartbeat, reconnect, and cursor resubscription. Add bounded resume validation and browser lifecycle signals without trusting `readyState` alone.
- `src/renderer/hooks/use-acp-history.ts:17-41` and `src/renderer/stores/acp-store.ts:3665-3683,5356-5376` -- history loads currently permit an unhandled rejection; retain the prior index and retry after a successful reconnect.
- `src/renderer/lib/acp-transport.test.ts:1358-1679` and Rust tests in `web/ws.rs` -- existing fake-socket/watchdog patterns to extend.
- `_bmad-output/implementation-artifacts/spec-fix-web-acp-active-turn-disconnect-recovery.md` -- prior active-turn analysis; context only.

## Tasks & Acceptance

**Execution:**
- [x] `src-tauri/src/web/ws.rs` -- dispatch authenticated `send_prompt` outside the connection read loop, preserving request ID and completion after disconnect; release the exact turn claim on every non-completed path.
- [x] `src-tauri/src/web/ws.rs` -- centralize per-connection subscription cleanup after either read or write termination so watchdog/write failure cannot bypass unregister, permission grace, or question cleanup.
- [x] `src/renderer/lib/acp-transport.ts` -- on visibility return, `pageshow`, browser `resume`, and `online`, perform a bounded application `ping`; force reconnect/cursor replay when it fails. Coalesce validation/reconnect and detach listeners on dispose.
- [x] `src/renderer/lib/acp-transport.ts` -- do not report reconnect success until the socket is authenticated and required subscriptions have recovered; log failed session IDs through the renderer log facade without transcript data.
- [x] `src/renderer/hooks/use-acp-history.ts` / `src/renderer/stores/acp-store.ts` -- catch transient history-index failures, preserve current entries, and refetch after reconnect success.
- [x] Add deterministic TypeScript and Rust regressions for long-turn heartbeat concurrency, watchdog-first cleanup, stale-OPEN resume validation, lifecycle coalescing, history failure preservation, and reconnect refetch.

**Acceptance Criteria:**
- Given an accepted agent turn is still running, when the browser backgrounds and the old socket dies, then the host turn continues and its persisted/replayed outcome is available after reconnect.
- Given Chrome returns with a stale socket, when the first foreground health check fails, then Termul reconnects and resubscribes without waiting 60 seconds or surfacing an unhandled `AcpTransportError`.
- Given the server watchdog ends the write half first, when relay shutdown completes, then subscriber count is zero and disconnect policy executes exactly once.
- Given history refresh fails during transport recovery, when reconnect succeeds, then the previous sidebar remains visible and a successful refetch converges it to host state.

## Spec Change Log

- 2026-08-12: Applied independent-review patches for socket lifecycle coalescing, fresh-socket subscription recovery, transient history retry/generation ordering, cancellation-safe relay cleanup, and accepted-turn persistence/replay. Removed unrelated title-normalization work from this change.

## Design Notes

Cloudflare documents that WebSockets may terminate during network releases and recommends keepalive. Browser lifecycle guidance requires revalidation after resume because suspended tabs throttle timers and `readyState === OPEN` does not prove a working round trip. Reconnect is transport replacement plus cursor resume, not a new chat session.

Offline outbox persistence, automatic prompt retransmission, browser transcript authority, and replay-protocol redesign remain out of scope: automatic resend without acknowledgements risks duplicate agent turns.

## Verification

**Commands:**
- `bun run ci` -- Biome lint, format, and import sorting pass.
- `bun run typecheck` -- node, web, and test TypeScript checks pass.
- `bun run test` -- all Vitest suites pass, including new transport/history regressions.
- `cd src-tauri && cargo clippy --all-targets -- -D warnings` -- Rust lint passes.
- `cd src-tauri && cargo test` -- Rust tests pass, including relay concurrency and cleanup regressions.

**Manual checks (if no browser harness):**
- Through the active Cloudflare tunnel, start a long response, background Chrome beyond 75 seconds, return, and confirm the transcript remains intact, reconnect finishes, history reloads, and a later prompt can be sent without page reload.

**Verification results (2026-08-12):**
- `bun run ci` passed: 816 files checked with no errors.
- `bun run typecheck` passed for node, web, and test configurations.
- Focused ACP Vitest passed: 2 files, 281 tests.
- Two full `bun run test` attempts each completed 3,615 tests with one different unrelated order-sensitive failure; both failing files passed when rerun alone (`WorkspaceLayout.mobile.test.tsx`: 6/6, `chat-markdown-code.integration.test.tsx`: 1/1).
- `cargo fmt --all -- --check` passed.
- Strict `cargo clippy --all-targets -- -D warnings` reached three unrelated `clippy::redundant_closure` findings in `src-tauri/src/web/git_api.rs`; rerunning with only that pre-existing lint allowed passed.
- Full Rust tests passed through the Windows Common-Controls v6 manifest workaround: 941 passed, 2 ignored. Focused `web::ws::tests::` passed 80/80.
- `git diff --check` passed.
- Cloudflare tunnel manual lifecycle verification was not run in this environment.

## Suggested Review Order

**Server relay dispatch & cleanup**

- Non-blocking `send_prompt` dispatch: accept inline, complete detached
  [`ws.rs:785`](../../src-tauri/src/web/ws.rs#L785)
- Exactly-once cleanup guard runs after either socket half or relay cancellation
  [`ws.rs:689`](../../src-tauri/src/web/ws.rs#L689)
- Centralized subscription + permission/question disconnect cleanup
  [`ws.rs:823`](../../src-tauri/src/web/ws.rs#L823)
- Accepted-turn survival: `accept_send_prompt` claims + starts inline, `complete_send_prompt` detached
  [`ws.rs:2757`](../../src-tauri/src/web/ws.rs#L2757)
- Snapshot recovery distinguishes permanent `not_found` from transient failures
  [`ws.rs:1284`](../../src-tauri/src/web/ws.rs#L1284)

**Turn-claim cancellation safety**

- RAII `PromptClaim` releases on drop if the detached task is aborted
  [`ws.rs:2725`](../../src-tauri/src/web/ws.rs#L2725)
- `TurnWatermark` claim/completion/release semantics
  [`permissions.rs:1128`](../../src-tauri/src/web/permissions.rs#L1128)
- `start_prompt` awaits driver acceptance before returning (cancel cannot no-op)
  [`manager.rs:1343`](../../src-tauri/src/acp/manager.rs#L1343)

**Browser resume validation & reconnect**

- Bounded application `ping` on visibility/pageshow/resume/online signals
  [`acp-transport.ts:1039`](../../src/renderer/lib/acp-transport.ts#L1039)
- `validateRoundTrip` replaces stale OPEN sockets instead of trusting `readyState`
  [`acp-transport.ts:1074`](../../src/renderer/lib/acp-transport.ts#L1074)
- Reconnect stays active until all required subscriptions recover; obsolete `not_found` sessions are dropped
  [`acp-transport.ts:1234`](../../src/renderer/lib/acp-transport.ts#L1234)
- Backoff coalescing guards prevent lifecycle storms from resetting attempts
  [`acp-transport.ts:1216`](../../src/renderer/lib/acp-transport.ts#L1216)

**History recovery & logging**

- Transient history failures preserve sidebar; non-transient errors still reject
  [`acp-store.ts:3669`](../../src/renderer/stores/acp-store.ts#L3669)
- Post-reconnect refetch with bounded retry; budget resets per reconnect cycle
  [`acp-store.ts:5392`](../../src/renderer/stores/acp-store.ts#L5392)
- History hook catches transient failures without unhandled rejections
  [`use-acp-history.ts:23`](../../src/renderer/hooks/use-acp-history.ts#L23)

**Tests**

- Rust: long-prompt concurrency, writer-first cleanup, cancelled-claim release, accepted-turn replay
  [`ws.rs:3390`](../../src-tauri/src/web/ws.rs#L3390)
- TypeScript: stale-OPEN validation, lifecycle coalescing, failed-subscription retry, history preservation
  [`acp-transport.test.ts:1471`](../../src/renderer/lib/acp-transport.test.ts#L1471)
  [`acp-store.test.ts:4079`](../../src/renderer/stores/acp-store.test.ts#L4079)
