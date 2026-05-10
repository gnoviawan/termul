# Blind Hunter Adversarial Review Findings

**Reviewer:** BLIND HUNTER (zero project/spec context — diff only)
**Artifact:** `gh133` diff (21 files touched)
**Findings:** 16 issues identified

---

### 1. [CRITICAL] Deferred kill operations are silently lost with no replay mechanism

`pty/manager.rs` — when `kill()` is called while `is_hidden` is true, it returns `Ok(())` without executing the kill. There is **zero logic** in `set_hidden(false)` (the visibility-restored path) to replay or process deferred kills. Any caller that issued a kill while the window was hidden gets a successful return code and never learns that the terminal is still alive. This is a **silent data leak** — orphaned terminal processes accumulate indefinitely.

### 2. [CRITICAL] Premature buffer truncation on visibility-hidden transition

`use-visibility-state.ts` — `applyAppHiddenState(false)` → calls `store.truncateHiddenTerminalBuffers()` **synchronously**, before the `HIDDEN_BUFFER_TRUNCATION_DELAY` has elapsed. The whole point of the delay is to wait before truncating, but the very first thing that happens on hide is an immediate truncation. This can discard data that arrived right at the hide boundary.

### 3. [HIGH] `mergeScrollback` priority inversion causes data loss

`useTerminalAutoSave.ts` — `mergeScrollback` was reordered: `snapshot` now takes priority over `transcript`. If `snapshot` contains stale scrollback data and `transcript` has fresh output, the stale snapshot wins. No explanation is given for this semantic reversal. Previously fresh transcript data was preferred; now it can be silently discarded.

### 4. [HIGH] `setRendererAttached(true)` races with backend `addRendererRef`

`ConnectedTerminal.tsx` — the frontend state is set (`setRendererAttached(true)`) **before** the async `addRendererRef` call. On rapid mount/unmount cycles:
1. Mount: `setRendererAttached(true)` — frontend state set
2. Unmount: `setRendererAttached(false)` — frontend state cleared
3. (later) Mount's async `addRendererRef` finally reaches the backend

Now the backend thinks a renderer ref exists but the frontend reports no attachment. The new unmount code (removing the `if (!externalTerminalId)` guard) makes this worse — now **every** terminal gets `setRendererAttached(false)` on unmount regardless of origin.

### 5. [HIGH] Transcript included in auto-save change detection creates a write storm

`useTerminalAutoSave.ts` — `t.transcript !== prev.transcript` is now a change-detection criterion. Terminal transcript changes on every keystroke, every output byte. This fires the auto-save persistence callback at line-frequency rates, causing **massive disk I/O** under heavy CLI workloads (Pi, Claude Code, builds). Autosave was presumably designed for structural changes (name, shell, cwd), not for high-frequency data.

### 6. [MEDIUM] `detachedOutput` truncated when it was intentionally raw

`terminal-store.ts` — `appendDetachedOutput` now routes through `trimTranscriptToMaxChars`, capping at `MAX_TRANSCRIPT_CHARS`. The `detachedOutput` field was specifically designed as **raw, untrimmed PTY output** for replay when no renderer is present. Truncating it defeats its purpose: when the renderer returns, the replay will start mid-stream with missing data.

### 7. [MEDIUM] `truncateHiddenTerminalBuffers` now truncates `detachedOutput` too

`terminal-store.ts` — the truncation function now slices `detachedOutput` down to `TRUNCATED_BUFFER_SIZE` lines. Same problem as finding #6: `detachedOutput` is meant to be the complete replay buffer. Reducing it to 5000 lines makes the "detached" capture nearly useless for any long-running terminal.

### 8. [MEDIUM] Double-capture of output when app is hidden with attached renderer

`use-terminal-detached-output.ts` — when `isAppHidden === true` AND `rendererAttachmentCount > 0`, the hook **still captures output** (because `shouldCaptureReplayHistory = true`). The attached renderer is presumably also capturing output into its own state. Result: every byte of output is stored **twice** in memory while the app is hidden — once by the renderer, once by the detached-output hook.

### 9. [MEDIUM] `setAppHidden` doesn't apply retroactively to terminals created while hidden

`terminal-store.ts` — `setAppHidden(true)` iterates over the **current** `terminals` array and stamps `isAppHidden=true` on each one. If a new terminal is created after `setAppHidden(true)` was called, it has `isAppHidden: false` (default) while all pre-existing terminals have `isAppHidden: true`. Inconsistent state that could cause partial behavior — some terminals get deferred kills, others don't.

### 10. [MEDIUM] Test for hidden-timer stability is a false positive

`terminal-store.test.ts` — test "does not reset hidden timers on repeated hidden notifications" calls `setAppHidden(true)` with zero terminals in the store, then accesses `terminals[0]?.appHiddenSince`. Both calls return `undefined`, so `expect(secondHiddenSince).toBe(firstHiddenSince)` passes **vacuously** — there are no terminals to test against. This test proves nothing.

### 11. [MEDIUM] `trimTranscriptToRecentLines` normalizes line endings

`terminal-store.ts` — splits on `/\r\n|\r|\n/` but joins with `\n` (LF). On Windows, where the original data used `\r\n` line endings, this silently normalizes to Unix-style. If the transcript is ever serialized or displayed where CRLF is expected, the line endings will be wrong. No `\r\n` preservation logic is present.

### 12. [LOW] ConPTY lifecycle mitigation is Windows-only but applied unconditionally

`pty/manager.rs` — all the deferral logic and comments reference "ConPTY lifecycle issues on Windows," but there is **no platform guard**. The `set_hidden`, `is_hidden`, orphan-skip, and kill-deferral logic runs on macOS and Linux too, where there is no ConPTY issue. The `#[cfg(target_os = "windows")]` pattern already exists in the same file (see `get_default_shell`) — this should follow the same pattern.

### 13. [LOW] `visibilityApi.setVisibilityState` failure is fire-and-forget with no retry

`use-visibility-state.ts` — the broadcast is fire-and-forget with a catch that only logs a warning. If the IPC call fails (backend not ready, serialization error, channel full), the visibility state is silently lost. The backend will continue polling at the wrong rate, potentially wasting CPU cycles or missing terminal updates.

### 14. [LOW] `syncVisibilityState` promise is never caught

`use-visibility-state.ts` — `handleVisibilityChange` and the focus-change callback both call `void syncVisibilityState()`. If `syncVisibilityState` rejects (e.g., `getCurrentWindow().isMinimized()` throws), the rejection is unhandled and becomes an **unhandled promise rejection**, which Node.js/Chromium treats as a fatal error in some configurations.

### 15. [LOW] Log messages are misleading about what they actually do

`pty/manager.rs` — `set_hidden(true)` logs `"PTY kill/deferral enabled"` but the `set_hidden(false)` path logs `"PTY kill/deferral disabled"`. When the app is visible, no kill or deferral happens at all — the log implies something was "disabled" that was never running. These messages conflate "enabling deferral mode" with "kill operations are deferred."

### 16. [LOW] `is_hidden` uses `Ordering::Relaxed` with no justification comment

`pty/manager.rs` — all atomic loads/stores on `is_hidden` use `Ordering::Relaxed`. While this is technically safe for a boolean flag in many cases, the fact that it gates **process termination** (the orphan-detection loop decides whether to kill processes based on this flag) warrants a comment explaining why relaxed ordering is sufficient. Without one, the next maintainer may incorrectly "fix" it to `SeqCst`.
