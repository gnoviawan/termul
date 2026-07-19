# Deferred Work

## From: Cleanup stale worktrees and caches (2026-07-14)

- **Locked empty leftovers** — Close processes holding these paths, then delete:
  - `E:\open-source\PecutAPP\termul-worktrees\acp-provider-setup-recovery` (and the empty `termul-worktrees` parent)
  - `E:\open-source\PecutAPP\termul\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi` (empty `target` shell after `cargo clean`)
- **Post-cleanup smoke** — Reinstall and rebuild when needed: `bun install`, then `bun run tauri:dev` / `cargo build` as appropriate. Cold build will be slow after cache wipe.
- **Worktree lifecycle policy** — Add a retention rule or script (merge → remove worktree → delete local branch; periodic orphan-folder scan) so ~100+ GB bloat does not return.
- **Windows ownership / lock checklist** — Before future mass removals: add `safe.directory` exceptions or fix ACLs, close Cursor agents/terminals using those roots, then verify `git status` is clean without `--force`.
- **Pre-deletion artifact capture** — Export tip SHAs, stash lists, and `git log -5` per branch before `worktree remove --force` / `branch -D`.
- **External path consumers** — Audit Cursor agent roots, shortcuts, and terminals still pointing at deleted worktree paths.

## From: ACP warm session pool at startup (2026-07-19)

- **No automatic pool refill on agent reconnect** — after `_onAgentDisconnected` drops the warm slot, nothing proactively re-seeds the pool on reconnect (only on next agent/cwd switch or user chat). Mitigated by `startChat`'s inline fallback (no worse than today). The I/O-matrix disconnect row mentions "refill on next `ensureLiveAgent` success"; consider a reactive refill when `agentStatus` flips back to `connected`. Low–medium.
- **In-flight cancel can orphan a live (non-indexed) session in `s.sessions`** — when `retargetWarmPool`/`cancelPreparedChat` cancels an in-flight `prepareChat` AFTER `createSession({ephemeral})` resolved, the created session lingers in `s.sessions` (active, never closed/indexed) until agent disconnect or restart. Pre-existing pattern (reused per spec "do not duplicate dedupe"); improved by the ephemeral flag (was a disk orphan before). Low. Consider having the prepare task close its own session when it bails after `createSession`.

## Deferred from: code review of 1-1-d2-dispatcher-decoupling-apphandle-to-eventsink (2026-07-19)

- **`AcpEvent` lacks `Serialize` + `type_` field name diverges from documented WS envelope `{sid, seq, type, payload}`** [`src-tauri/src/web/sink.rs`] — Story 1.4 will add `Serialize` + `seq` + rename `type_` → `type` when the WS relay lands. The spec's "What NOT to do" fence explicitly excludes seq/cursor from Story 1.1.
- **`WsRelaySink` recorder grows without bound (no capacity cap, no drain-on-full)** [`src-tauri/src/web/sink.rs:138`] — type is `#[allow(dead_code)]` stub, not constructed in production in this story; Story 1.4 wires it live and will handle capacity/backpressure.
- **`drive_connection` / `run_command_loop` clone the sink `Vec` repeatedly (3× per connection + per request/turn)** [`src-tauri/src/acp/manager.rs`] — spec Dev Notes explicitly blessed `sinks.clone()` as "cheap — Arc clones"; passing `&[Arc<dyn EventSink>]` slices is a micro-opt that re-opens the signatures just refactored. Defer to a future optimization pass.
- **`AcpManager::new(vec![])` silently drops every `acp:*` event in production wiring (documented but not enforced)** [`src-tauri/src/acp/manager.rs`] — `vec![]` is intentionally blessed for unit tests; production sink wiring is Story 1.2/1.10's job. A `debug_assert!(!sinks.is_empty())` now would break the blessed test path. Defer.

## Deferred from: code review of 1-2-standalone-server-binary-and-web-build-scaffold (2026-07-19)

- **Monolithic `termul_manager_lib` still pulls Tauri/WebKit for `termul-server` Linux CI** — true headless crate split is later work; Story 1.2 scaffolds the binary against the existing lib.
- **Abnormal process death (`kill -9` / OOM) cannot run `AcpManager::kill_all`** — OS limitation; graceful signal path covers SIGINT (and SIGTERM on Unix).
- **Optional `build.rs` release existence check for `dist-web/`** — Story 1.11 owns full embedding enforcement; this story only feature-gates `rerun-if-changed`.
