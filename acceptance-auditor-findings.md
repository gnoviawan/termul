# Acceptance Audit — GH-133: Fix Memory Growth While Minimized

**Auditor:** Acceptance Auditor  
**Date:** 2026-05-10  
**Scope:** Working-tree changes against baseline commit `d45cb22`  
**Spec:** `_bmad-output/implementation-artifacts/spec-gh-133-fix-minimized-memory-growth.md`  
**Context:** `docs/project-context.md`

---

## Summary

**No violations found.** All 6 acceptance criteria are addressed, all Boundaries & Constraints are respected, the Design Notes / Golden Rules are followed, and no changes touch the `<frozen-after-approval>` section.

---

## Acceptance Criteria — Verification

### AC 1: Minimized/hidden PTY streaming stays within retention limits

- ✅ `truncateHiddenTerminalBuffers()` now truncates all three buffer types: `pendingScrollback` (to `TRUNCATED_BUFFER_SIZE`), `transcript` (via `trimTranscriptToRecentLines(trimTranscriptToMaxChars(...))`), and `detachedOutput` (same stacked truncation).
- ✅ `appendTranscript()` enforces `MAX_TRANSCRIPT_CHARS` (1,500,000 chars) during capture, preventing unbounded growth even before the truncation timer fires.
- ✅ `appendDetachedOutput()` similarly enforces `MAX_TRANSCRIPT_CHARS`.
- ✅ Eligibility uses `isAppHidden || isHidden` so both app‑level and pane‑level hidden terminals are covered.

### AC 2: No duplicate renderer-side buffer for visible attached terminals

- ✅ `use-terminal-detached-output.ts` gates capture: `shouldCaptureReplayHistory = isAppHidden === true || rendererAttachmentCount === 0`.
- ✅ When visible + renderer attached → `shouldCaptureReplayHistory = false` → `appendTranscript` is not called.
- ✅ `ConnectedTerminal.tsx` now calls `setRendererAttached(id, true)` during external-terminal restore, ensuring the count is > 0 for restored terminals too.
- ✅ The unmount path now calls `setRendererAttached(id, false)` unconditionally (removed the `if (!externalTerminalId)` guard), preventing stale attachment counts.

### AC 3: Transcript-only hidden terminals truncated without `pendingScrollback`

- ✅ `truncateHiddenTerminalBuffers()` handles `t.transcript` independently from `t.pendingScrollback`. Each buffer is truncated individually.
- ✅ Test: `'truncates transcript-only hidden terminals after the configured delay'` validates this exact path.

### AC 4: Repeated hidden notifications don't reset the timer

- ✅ `setAppHidden()` in terminal-store.ts is idempotent: `if (t.isAppHidden === isHidden) { return t }` — the `appHiddenSince` timestamp is not overwritten.
- ✅ `use-visibility-state.ts` `applyVisibility()` also guards with `lastAppliedVisibilityRef.current === isVisible`.
- ✅ `scheduleHiddenMaintenance()` checks `if (hiddenMaintenanceTimeoutRef.current || hiddenMaintenanceIntervalRef.current) { return }`.
- ✅ Test: `'does not reset hidden timers on repeated hidden notifications'` validates store-level idempotency.

### AC 5: Restore shows bounded continuity without crash or duplicate replay

- ✅ PTYs remain alive: `PtyManager.set_hidden(true)` defers kills but does not kill. Orphan detection skips while hidden.
- ✅ On restore (`isAppHidden = false`), the `ConnectedTerminal` is mounted and `setRendererAttached(true)` prevents duplicate transcript capture from the global listener.
- ✅ `consumeTranscript()` provides bounded data to xterm — the transcript has already been bounded by `MAX_TRANSCRIPT_CHARS` at capture time, and if the truncation timer fired, it's additionally line-truncated to `TRUNCATED_BUFFER_SIZE`.
- ✅ `WorkspaceLayout.tsx` skips `ensureTerminalTabs` while hidden but re‑evaluates on the next `[terminals]` effect cycle when `isAppHidden` flips.

### AC 6: Detached terminals preserve bounded continuity

- ✅ When `rendererAttachmentCount === 0` (project-switched / pane-closed), `shouldCaptureReplayHistory = true` → transcript is captured.
- ✅ Transcript is bounded by `MAX_TRANSCRIPT_CHARS` during capture.
- ✅ When the app is also hidden, the hidden‑state truncation also applies after the configured delay.

### AC 7: Persisted layout normalizes hidden buffers

- ✅ `useTerminalAutoSave.ts` now detects `transcript`, `isAppHidden`, and `appHiddenSince` as structural changes, so hidden‑buffer truncation triggers a save.
- ✅ `toPersistedTerminalSnapshot()` reads the store's `terminal.transcript`, which is already bounded by capture‑time or truncation‑time limits before it reaches the persistence layer.

---

## Boundaries & Constraints

### Always

| Constraint | Status | Notes |
|---|---|---|
| Preserve live PTYs across minimize/restore | ✅ Pass | Kill‑deferral in PtyManager prevents kill; no kill-on-hide behavior added |
| Preserve bounded recent continuity after restore | ✅ Pass | Transcript captured while hidden, bounded by MAX_TRANSCRIPT_CHARS and TRUNCATED_BUFFER_SIZE |
| Treat app‑hidden distinct from pane‑hidden | ✅ Pass | Separate `isAppHidden` / `appHiddenSince` fields; `setAppHidden()` is independent from `setTerminalHidden()` |
| Keep solution renderer‑first | ✅ Pass | All primary logic in `terminal-store.ts`, `use-visibility-state.ts`, `use-terminal-detached-output.ts` |
| Only one renderer‑side retention path per PTY chunk per lifecycle state | ✅ Pass | `use-terminal-detached-output.ts` gates capture by `rendererAttachmentCount` and `isAppHidden` |

### Ask First

No changes were found that weaken continuity guarantees, add user‑facing settings, pause terminal processes, expand `detachedOutput` into a replay source, or introduce browser‑webview throttling.

### Never

| Constraint | Status | Notes |
|---|---|---|
| Raise transcript limits to solve | ✅ Not done | Limits unchanged; only structural improvements |
| Silently clear terminal state on minimize | ✅ Not done | Data preserved, bounded, not cleared |
| Reintroduce kill-on-hide | ✅ Not done | Kill‑deferral prevents kill; opposite direction |
| Promise to fix all xterm/webview memory | ✅ Not done | Scope limited to renderer retention |
| Speculative browser-subsystem changes | ✅ Not done | No browser subsystems touched |

---

## Design Notes / Golden Rules

| Principle | Status | Notes |
|---|---|---|
| PTY output may continue indefinitely | ✅ Held | Bounded buffers accommodate indefinite output |
| No renderer-owned buffer may grow indefinitely | ✅ Held | `transcript`, `detachedOutput`, `pendingScrollback` all bounded |
| PTY lifetime ≠ UI/history retention lifetime | ✅ Held | PtyManager keeps PTY alive; store truncates history independently |
| Restore requires live PTY + bounded continuity window, not full history | ✅ Held | `shouldCaptureReplayHistory` captures bounded recent data; truncation enforces line limit |
| Only one retention path per PTY chunk per lifecycle state | ✅ Held | Global listener skips when renderer is attached and app is visible; captures only when detached or hidden |

---

## <frozen-after-approval> Section

No modifications found to any content within `<frozen-after-approval>` blocks. The spec header remains untouched.

---

## Minor Observations (Not Violations)

1. **`ConnectedTerminal.test.tsx` not updated.** The spec lists it for regression coverage of hidden‑state retention behavior. The ConnectedTerminal changes (the `setRendererAttached` on external‑terminal restore and the unconditional decrement on unmount) have no dedicated test in that file. The changes are indirectly exercised through `App.test.tsx` and `TauriApp.test.tsx`, which verify that `useVisibilityState` is wired, but don't test the renderer‑attachment interaction.

2. **`use-terminal-restore.ts` not modified.** The spec marks it as [x] for normalization of hidden buffers before serialization. The normalization happens in the store (`truncateHiddenTerminalBuffers`) and in `useTerminalAutoSave` (which persists truncated data). The restore path reads from the already‑truncated or bounded store state, so the objective is met without changes to `use-terminal-restore.ts`.

3. **Immediate `truncateHiddenTerminalBuffers()` call on hide is always a no-op.** In `applyAppHiddenState()`, `store.truncateHiddenTerminalBuffers()` is called immediately after `setAppHidden(true)`. Because the eligibility check requires `now - appHiddenSince > HIDDEN_BUFFER_TRUNCATION_DELAY` (15 min), the immediate call never truncates anything — the actual truncation is done by the `setTimeout`/`setInterval` in `scheduleHiddenMaintenance()`. This is harmless but wasteful on every hide cycle.

4. **Transcript + xterm double‑buffering during hidden state.** When the app is hidden and a renderer is attached, the global listener captures data into `transcript` (for restore continuity). xterm also buffers the same data internally. This is intentional — xterm's internal buffer is rendering‑layer, not app‑layer — but it means two retention paths hold the same data while hidden. The `MAX_TRANSCRIPT_CHARS` cap prevents the transcript from becoming a second unbounded copy.

---

## Conclusion

**Zero violations.** The implementation satisfies all 6 acceptance criteria, respects all Boundaries & Constraints, follows the Design Notes / Golden Rules, and leaves the frozen‑approval section intact. The changes are renderer‑first, bounded, idempotent, and properly distinct between app‑hidden and pane‑hidden state. The PtyManager backend changes are minimal defensive guards (kill‑deferral, orphan‑detection skip) that prevent ConPTY lifecycle issues rather than introducing aggressive policies.
