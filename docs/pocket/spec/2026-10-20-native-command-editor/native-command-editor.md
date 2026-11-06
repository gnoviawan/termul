# Native command editor

**Date:** 2026-10-20
**Status:** approved
**Author:** brainstorm session
**Spec path:** docs/pocket/spec/2026-10-20-native-command-editor/native-command-editor.md
**Issue:** https://github.com/gnoviawan/termul/issues/1484

---

## Summary

Termul's terminal input is still the xterm.js keystroke stream written straight to the PTY. `currentLineRef` cannot reconstruct the real shell line. This spec moves input ownership to a client-owned command editor while the shell is at a trusted prompt, and leaves xterm.js as the continuous scrollback and the interactive PTY surface.

The editor and the shell cooperate through a Termul session protocol. Shell completion runs in-band on that same PTY so aliases, functions, shell config, and session context stay real. Completion is an internal operation. It is not a user command.

---

## Context

### Current State

- `ConnectedTerminal` forwards every xterm `onData` event through `terminalApi.write`. `currentLineRef` only appends printables and handles backspace, Ctrl+C, and Enter (`src/renderer/components/terminal/ConnectedTerminal.tsx`). The file is 2007 lines.
- There is no injected shell integration. `ExitCodeTracker::parse_exit_code` reads ambient OSC `133;D` and `__TERMUL_EXIT__` (`src-tauri/src/trackers/exit_code_tracker.rs`). Those bytes are not a mode signal.
- Unix CWD is polled from `/proc/{pid}/cwd` about every 500ms. Windows `CwdTracker::detect_cwd` returns `None` (`src-tauri/src/trackers/cwd_tracker.rs`). `Terminal` already stores `cwd`, `gitBranch`, and `lastExitCode` (`src/renderer/types/project.ts`).
- Command history stores one trimmed string, skips whitespace-only input, keeps internal newlines, and caps at 500 entries per project (`useAddCommand`, `MAX_HISTORY_ENTRIES`).
- Desktop shared-live sets `allow_remote_writes: false` (`src-tauri/src/remote/host.rs`). The browser write path can report success for input that is only queued offline, and flush is at-least-once (`WebTerminalClient.write`, `flushInputBuffer`).
- `PtyManager::write` is `write_all` plus `flush` (`src-tauri/src/pty/manager/lifecycle.rs`). A failure after the first byte does not report how many bytes were written.
- The PTY reader parses exit codes, then runs `DaFilter`, then forwards the filtered bytes (`reader_loop` in `src-tauri/src/pty/manager/spawn.rs`). `DaFilter` answers DA queries and still forwards those query bytes.
- `TerminalEventHub` is a process-wide broadcast with capacity 256 (`src-tauri/src/trackers/terminal_events.rs`). It is not addressed to one client.
- `terminalApi` switches Tauri IPC and the browser websocket with `isTauriContext()` (`src/renderer/lib/terminal-api.ts`). `TerminalApi` has `write` and no submit or completion method (`src/shared/types/ipc.types.ts`).

### Problem / Motivation

A Warp-like composer needs the real command buffer: cursor, selection, multiline text, ghost text, a completion dropdown, and history recall. The current pipe cannot provide that buffer. Output rendering stays a continuous xterm scrollback. Output blocks are a later subscriber of the same lifecycle, not part of this work.

### Related Areas

- Renderer mount: `src/renderer/components/terminal/ConnectedTerminal.tsx`, `src/renderer/components/workspace/PaneContent.tsx`, `src/renderer/components/ssh/SSHSessionView.tsx`.
- Keys and mobile: `src/renderer/components/terminal/keymap.ts`, `src/renderer/components/mobile/MobileTerminalControls.tsx`, `src/renderer/hooks/use-terminal-clipboard.ts`.
- History and assist insert: `src/renderer/hooks/use-command-history.ts`, `src/renderer/stores/command-history-store.ts`, command palette insert, terminal assist insert.
- Runtime: `src-tauri/src/pty/`, `src-tauri/src/trackers/`, `src-tauri/src/web/terminal_ws.rs`, `src-tauri/src/remote/host.rs`.
- Design tokens: `docs/design/forms.md`.

---

## Scope

### In-Scope

- Native command editor shown only while the session is a trusted at-prompt Editor. It unmounts and yields focus to xterm in every other state.
- Inline ghost text, completion dropdown, and command-history popup.
- Display-only context chips for the existing CWD and git branch.
- Continuous xterm scrollback. A submitted command is echoed once. The integrated shell prompt glyph is not left visible.
- Interactive TUI and any non-prompt state use the raw PTY, including programs that own the alternate screen.
- In-band shell completion on the same PTY, under the invariants and scheduling rules in this spec.
- Local interactive bash and zsh integration. Other shells stay raw until a real authenticated prompt is observed.
- Desktop, desktop shared-live, `termul-server`, and the browser client follow the same behavior, with the viewer and multi-writer rules below.
- Lifecycle events a future block renderer can subscribe to. No block renderer is built now.

### Out-of-Scope

- Warp-style output blocks and any block grid.
- The AI natural-language box. Issues #49 and #259 stay separate. Assist insert only changes its target when the editor owns the buffer.
- A Node version chip, chip click actions, and any new metadata poll.
- Replacing xterm.js or the Rust PTY.
- A pretyping queue. Keys typed before the editor is mounted, or while a command is running, are discarded. They are not stored for the next prompt.
- Injecting fish, PowerShell, cmd, dash, or SSH in v1. Fish OSC 133 is not trusted.
- Completion on bash older than 4. The editor still works there. Its generator entry point calls no completer and returns an empty Completion frame.
- Completion while the cursor is inside an open quote. The v1 bash generator splits the draft on whitespace, so a quoted word with a space is not one word.
- Bash completions that need bash-completion when it is not installed, such as `git`. The shell has no completer, so it returns none.
- Background generators that run a plain command such as `git branch` in a subshell. v1 uses only the shell's own completers.
- A persisted "force raw input" preference. Handshake failure is the rollback.
- The landing site.
- Copying AGPL source from warpdotdev/warp. That repository is an architectural reference only.
- Splitting, moving, or reorganizing an existing file. This change is contributed to someone else's repository, so an existing-file split in the same PR would bury the feature in a large diff. The size guideline applies to new files only. The follow-up split of `ConnectedTerminal.tsx` and `web-terminal-api.ts` is https://github.com/gnoviawan/termul/issues/1487.

---

## Architecture Constraints

- Layers this work may touch: a new renderer editor and lifecycle coordinator, new `terminalApi` methods on both transports, a new Rust session-protocol filter beside the PTY reader, original bash and zsh integration scripts, and a single completion-refresh preference.
- Layers this work must not touch: xterm as the scrollback renderer, the landing site, output-block UI, and the interior of an existing file as a place to grow the new behavior. `ConnectedTerminal.tsx` is 2007 lines and stays that way. Do not split it, and do not split `spawn.rs`, `web-terminal-api.ts`, `lifecycle.rs`, or any other existing module in this PR.
- Existing files receive the smallest wiring that mounts the feature: a call, a method on the facade, or a branch that delegates. The new behavior lives in new files. When a new file would pass about 800 production lines, split that new file into further new files before it lands. Do not extract code out of an existing file to make that happen. Rust tests for a new module are a new sibling file. A split of a new file must not leave an orphaned import.
- Patterns that must be followed: host-backed behavior behind `terminalApi`; parity for Tauri and web; explicit `isTauriContext()` gating only for a capability that is intentionally absent; semantic tokens from `docs/design/forms.md`; `log` on the Rust side and `logFrontendError` on the renderer. Do not add `tracing`. Logs name the mode change and the failure class. They omit the buffer, paste, credentials, and completion payload.
- Live PTY processes survive a project switch.
- Keep `src/shared/` to runtime-neutral contracts. Editor behavior stays in `src/renderer/`. Protocol parsing and PTY writes stay in `src-tauri/`.
- Do not add a new application-root provider. Session state lives with the terminal pane and the stores both app roots already mount.
- Architecture validation result: CONDITIONAL PASS. Evidence is in the table below. The third-party completer wrapper cannot be proven against every completer until it exists. Failure of that contract falls back as specified. That risk does not change the chosen protocol.

### Validation Evidence

Checked 2026-10-20 against the working tree and the installed packages `@xterm/xterm@6.1.0-beta.287` and `@codemirror/autocomplete@6.20.3`.

| Claim or constraint | Codebase evidence | External source | Result and finding |
|---|---|---|---|
| Input is not client-owned today | `ConnectedTerminal` `handleTerminalData` writes every `onData` chunk and tracks only a printable `currentLineRef` | n/a | PASS |
| No shell integration owns the mode | `ExitCodeTracker` parses OSC `133;D` and `__TERMUL_EXIT__` only | n/a | PASS |
| CWD and git branch already exist for chips | `Terminal.cwd`, `Terminal.gitBranch`; Unix poll; Windows `detect_cwd` returns `None` | n/a | PASS |
| History shape is `useAddCommand` | trim, skip empty, cap 500 | n/a | PASS |
| Command submit and completion must not use the keystroke queue | `WebTerminalClient.write` returns success for an offline buffer; `flushInputBuffer` documents at-least-once replay. `PtyManager::write` is `write_all` + `flush` with no byte count | n/a | PASS as a constraint. Submit and completion use a new host RPC |
| View-only clients cannot write | `allow_remote_writes: false` in `remote/host.rs` | n/a | PASS |
| Protocol bytes must be stripped on the host | `reader_loop` already filters before the pending output buffer. `DaFilter` still forwards DA bytes, so it is the wrong filter to extend | Installed xterm typings: `registerOscHandler` runs once when the sequence finishes, stores chunks until then, and limits OSC payload to 10 MB. Context7 `/websites/xtermjs`, accessed 2026-10-20, matches that API | PASS. Renderer-only OSC handling is not protocol isolation |
| Completion UI can use the installed editor stack | `@codemirror/state@6.7.0`, `@codemirror/view@6.43.4` are direct. `@codemirror/autocomplete@6.20.3` is transitive and not a direct dependency | Package `index.d.ts`: `completionKeymap` binds Enter to `acceptCompletion`; `defaultKeymap` installs it unless false; `activateOnTyping` defaults true; `activateOnTypingDelay` defaults to 100; `selectOnOpen` defaults to the first row selected. No ghost-text API on `Completion` | PASS. Add autocomplete as a direct dependency. Ghost text is our decoration. Set `defaultKeymap: false` |
| Completion events must not ride the shared output broadcast | `TerminalEventHub` capacity 256, every subscriber receives every event. Web attach subscribes in `terminal_ws` | n/a | PASS as a constraint. Completion results are the RPC reply to the caller |
| One generator can be serialized on the host writer | `PtyManager::write` holds `instance.writer` | n/a | PASS as the lock point. The RPC must hold that lock across cancel, clear, and the one command write |
| Warp may be studied and not copied | Clone used as behavior reference under `/tmp/warp-ref`. License AGPL-3.0 | n/a | PASS as a legal constraint |
| A wrapper can contain every third-party completer | No wrapper exists | n/a | UNVERIFIED. Contract below: if restore cannot be proven, do not run that provider; if the session is no longer trustworthy, fall back to raw |

Anti-patterns checked: god object, shared mutable editor state, race between completion and submit, non-idempotent PTY write, leaky scrollback. Mitigations are the new modules, per-client drafts, the host generator lock, host-accepted submit, and host-side protocol stripping.

---

## Dependencies

### Existing (to leverage)

- `@xterm/xterm@6.1.0-beta.287` — scrollback, TUI, and raw keystrokes in PTY mode. `attachCustomKeyEventHandler` already lets the app consume keys.
- `@codemirror/state@6.7.0` and `@codemirror/view@6.43.4` — the command buffer, selection, and ghost decoration.
- `@lezer/highlight` — small shell highlighting. Do not add a second editor.
- `terminalApi`, `TerminalEventHub`, `DaFilter`, `ExitCodeTracker`, `CwdTracker`, and `useAddCommand`.

### New (proposed)

- `@codemirror/autocomplete@6.20.3` as a direct dependency. It is already in `bun.lock`. The dropdown is the library tooltip. Enter-to-accept is rejected by `defaultKeymap: false`. Ghost text is not in this library.
- No new terminal emulator, parser framework, or shell.

---

## User command and internal completion

| Operation | User command | Internal completion |
|---|---|---|
| Send data to the PTY | Yes | Yes |
| Run an operation in the shell | Yes | Yes, internal only |
| Change the editor buffer | Not automatically | Only after the user accepts a suggestion |
| Enter command history | Yes | No |
| Trigger a normal Preexec | Yes | No |
| Change session mode | Yes | No |
| Make output visible | Yes | No |

Completion runs only while the shell is trusted `AtPrompt`. `CompletionPending` is an internal substate of `AtPrompt`. It does not unmount the composer and it is not `Executing`.

### Invariants

1. **Session-bound.** Every completion carries `session_id`, nonce, and `request_id`. Ignore a response from an old session, a cancelled or superseded request, or a shell that left the state the request was bound to.
2. **Serialized.** A completion never overlaps a user submit. Enter discards pending results, suppresses replacements, drains or cancels the active generator, then submits the draft once.
3. **Protocol-isolated.** The completion response is a structured host RPC result. Escape sequences, generator errors, and completion output are removed from the byte stream before xterm and before any shared-live subscriber.
4. **State-preserving.** A completion provider must leave CWD, environment, history, shell options, and the editor buffer unchanged. This is a wrapper contract. A provider that cannot be wrapped is not run. Other providers may still return results.
5. **Fail-safe.** Timeout, generator failure, a malformed response, or shell exit does not change the draft. If shell sync is no longer trustworthy, the session falls back to raw terminal mode and the draft is not executed.
6. **Owner-only.** A shared-live viewer cannot start completion. The completion RPC uses the same write authority as submit.

### Scheduling

Principle: invalidate on a meaningful context change, not on a repeated request for the same context.

- **Repeated Tab, same context.** Consume the key. Keep the current request running. Do not invalidate, cancel, restart, or queue a replacement only because Tab was pressed again.
- **Draft or cursor change while pending.** Invalidate the previous result immediately. If automatic completion refresh is enabled, coalesce to the latest context and schedule at most one replacement, started only after the current generator has safely finished or been cancelled. If refresh is disabled, do not schedule a replacement; wait for the next explicit completion request.
- **Enter while pending.** Submission wins. Discard pending results, suppress replacement requests, safely drain or cancel the active generator, then submit the current draft once.
- **Concurrency.** At most one active completion generator per PTY. No overlapping requests, no duplicate apply, and no outdated result applied to the editor.
- **Validity.** A result is applied only when it matches the active session, nonce, request id, input mode, buffer revision, cursor position, and relevant shell context.

Relevant shell context is the prompt generation and the CWD bound when the request was accepted. Environment and shell options are the wrapper's responsibility, not a field the client diffs on each keystroke.

`automaticCompletionRefresh` defaults to true because ghost text and the dropdown update while typing. The off state is a real preference on the existing app-preferences surface. Tests cover both.

Buffer revision increments on every document change and every cursor movement. Ghost text is not part of the document and does not bump the revision. Accepting a suggestion is a local document edit: it bumps the revision, clears the dropdown and ghost before the next key, and invalidates an in-flight result.

While no generator is active and refresh is on, a burst of edits starts one request for the latest context after a single coalesce window. The installed autocomplete delay default of 100ms is an acceptable window. The window must not start a second generator. While refresh is off, idle typing starts nothing.

An explicit Tab when nothing is showing and no request is in flight for this context starts one request. If a generator is still draining for an older context, that Tab becomes the single scheduled replacement and starts after the drain, using the latest context. A second Tab on the same context does not add another replacement.

---

## Stories + Scenarios

### Story: Trusted prompt owns the editor

> As a person at a shell prompt, I want the client to own the command line, so that cursor, history, and completion describe the real draft.

**Rule: Authenticated prompt only.** `PromptReady`, `CommandStarted`, and `CommandFinished` change mode only when they carry this session's nonce. Ambient OSC 133, OSC 633, `__TERMUL_EXIT__`, Starship, iTerm, and VS Code sequences do not mount the editor or hide the prompt. `__TERMUL_EXIT__` may still update the exit-code tracker.

**Rule: Editor means an empty trusted prompt with suppression proven.** The shell reports `prompt_suppressed` and `line_empty` on the authenticated prompt. If a prompt arrives without suppression, the session stays raw and the normal prompt stays visible. Characters typed before the first trusted prompt, or in the gap before the next editor, are discarded. They are not executed and not copied into the editor.

**Rule: The composer is the prompt.** It is mounted only in Editor. PTY mode, including a running command, an alternate-screen TUI, and a nested program, unmounts it and gives the keyboard to xterm. Leaving the alternate screen does not by itself return Editor. `sleep 100` does not time out into a raw prompt.

**Rule: v1 injection is local interactive bash and zsh.** A nested bash or zsh enters Editor only when it emits Termul-authenticated markers. fish, PowerShell, cmd, dash, SSH, and a direct program stay raw until a valid authenticated prompt is observed. A new shell process gets a new session id. Hooks for an unregistered id do nothing.

```gherkin
Scenario: Trusted prompt mounts an empty editor
  Given a local interactive zsh has completed the Termul handshake
  And the latest authenticated prompt has line_empty and prompt_suppressed
  When the prompt event is applied
  Then the composer is mounted
  And the buffer is empty
  And xterm does not show the shell prompt glyph

Scenario: Ambient OSC does not mount the editor
  Given the session has no Termul handshake
  When the PTY prints OSC 133 prompt markers
  Then the composer stays unmounted
  And the visible prompt remains

Scenario: Integration loss drops the editor
  Given the editor holds the unsent draft "git status"
  When the authenticated session becomes untrusted
  Then the composer unmounts
  And the draft is not written to the PTY
  And the shell shows its normal prompt on an empty line
  And the log names the fallback and omits the draft
```

### Story: Submit once

> As a person who presses Enter, I want that draft to run once in this persistent shell, so that cwd, aliases, and history stay the shell's own.

**Rule: One Enter is one submission of the current buffer.** The highlight of an open dropdown is not the submitted text. The host clears the shell line editor on every relevant keymap, then writes the buffer once. The shell echoes that write into xterm. The client does not also `term.write` the same line.

**Rule: Host acceptance is the commit.** Success is a desktop write that finished `write_all` and `flush`, or a web request whose socket actually accepted the frame. An offline queued accept is not success. History is recorded only after that acceptance, using `useAddCommand` (skip whitespace-only, otherwise one trimmed string, internal newlines kept). Empty Enter is not history. A history persistence failure does not resubmit and does not roll back the running command. The log omits the command text.

**Rule: Enter leaves the editor immediately.** Keys in the submitting window are discarded. They are not written and not appended. A failure before any PTY byte, while the session is still a trusted prompt, restores the editor and the original buffer, with no history and no `CommandStarted`. A `write_all` or `flush` error is treated as a partial delivery: stay out of the editor, show the existing write-failure error, write no history, and wait for the next authenticated shell state.

**Rule: The next editor opens empty.** Only the matching authenticated prompt after this submission mounts it. An intermediate prompt inside the submission does not. `CommandFinished` does not. A second prompt while an unsent draft is already open is ignored. `CommandStarted` or `CommandFinished` during an editor that has not submitted are ignored.

**Rule: Same-session draft restore.** A later trusted prompt on the same live session shows the unsent draft again after a failed pre-write submit or a transient raw fallback that did not exit the process. If the shell process has exited, the draft is dropped with the session.

```gherkin
Scenario: Enter submits the buffer once
  Given the editor buffer is "git remote -v"
  And the dropdown highlight is "git remote"
  When the user presses Enter
  Then the host clears the shell line and writes "git remote -v" once
  And xterm shows that command once
  And the composer is unmounted until the next matching trusted prompt
  And history stores "git remote -v"

Scenario: Enter while completion is pending
  Given the buffer is "git sta"
  And a completion generator is active
  And a replacement is scheduled
  When the user presses Enter
  Then pending results are discarded
  And the replacement is suppressed
  And the generator is drained or cancelled before the submit
  And the host writes "git sta" once
  And completion words are not submitted and are not history

Scenario: Pre-write failure restores the draft
  Given the editor buffer is "make test"
  And the session is still a trusted prompt
  When submit fails before any PTY byte is written
  Then the composer returns with "make test"
  And no history entry is added
  And CommandStarted is not committed

Scenario: Partial write does not pretend success
  Given submit already began writing to the PTY
  When write_all or flush returns an error
  Then the composer stays unmounted
  And no history entry is added
  And the session waits for the next authenticated shell state
```

### Story: In-band completion

> As a person typing a command, I want suggestions from this shell, so that aliases, functions, and the current directory are real.

**Rule: The host owns the generator.** The client calls a completion RPC. The host starts a generator only when the caller may write, the shell is trusted `AtPrompt`, and no generator is active. The client does not write the generator command through `terminalApi.write`.

**Rule: The wrapper is the state contract.** The generator runs where the interactive shell's aliases and functions exist, with history disabled and with CWD, environment, and shell options restored before it returns. If the wrapper cannot prove that restore, that provider is not started. If a restore check fails after the attempt, the result is dropped. If the session can no longer prove it is still the same prompt, fall back to raw and do not execute the draft.

**Rule: Apply only a valid result.** The result carries session id, nonce, request id, buffer revision, cursor, prompt generation, and CWD. The owner applies it only when every field matches. Everyone else ignores it. A mismatch leaves the draft byte for byte.

**Rule: Completion transport.** The host starts a generator by writing one line to the PTY. It first writes `ESC 0 D i Ctrl-U`, which empties the shell line in emacs, vi insert, and vi command mode. Then it writes `__termul_complete <request_id> <buffer_revision> <cursor> <hex of the draft up to the cursor>` and a carriage return. The draft is hex so quoting and keymaps cannot change it. The integration keeps that line out of history (bash `HISTIGNORE`, zsh `zshaddhistory`), so `!!` still recalls the last user command. A generator flag stops its preexec and precmd from announcing a user command or drawing a visible prompt. Bash calls the command's `complete -F` function with locally scoped `COMP_WORDS`, `COMP_CWORD`, `COMP_LINE`, `COMP_POINT` in bytes, and `COMP_TYPE`, and falls back to file and command names when none is registered. Zsh runs compsys in a real completion context and captures `compadd`. Completer stderr is discarded and never becomes a candidate.

**Rule: Completion frame.** The generator emits one Completion frame, last in its cycle. It echoes the request id, buffer revision, and cursor, and adds the prompt generation and `$PWD` the shell actually has. `output` holds newline-separated hex candidates, deduplicated, with a trailing space trimmed, at most 200, and the frame stays under the 64 KiB frame limit. After the frame the shell emits only terminal mode toggles and a clear to end of line.

**Rule: Completion isolation.** From the trigger write until the Completion frame, or until the drain watchdog fires, the host forwards no byte other than frames to xterm or any viewer. That includes the echo of the trigger line. Bytes after the frame pass through.

**Rule: Host validation.** The host accepts a Completion frame only with the session id and nonce it issued at spawn and the request id it is waiting for. Request ids are prefixed per connection, and only the connection that owns a request can cancel it. A request whose prompt generation or CWD differs from the last authenticated PromptReady is `NotStarted`. A frame whose prompt generation or CWD differs from that snapshot means the restore failed: the result is dropped and the session loses trust. The client checks buffer revision and cursor against its own request.

**Rule: Completion reply.** The reply is `{ result, outcome, completion? }`. `outcome` is `Completed`, `TimedOut`, `Cancelled`, or `Dropped`. `completion` carries the frame's request id, buffer revision, cursor, prompt generation, CWD, and `output`, and is present only for `Completed`. An absent field is omitted, never null. Finish, cancel, and timeout resolve through one decision, so each request gets exactly one outcome.

**Rule: Completion timeout.** The host completion timeout is about 1.5s. When it expires, the waiter ends but the generator may still occupy the shell, and a new request is `NotStarted` until it ends. `TimedOut` is sent when the occupancy ends, with any late frame discarded, or when the drain watchdog fires, which also ends trust. That reply tells the client a replacement may start. The client timeout is the host timeout plus the drain bound plus a margin. It only covers a lost reply, which the client treats as `Partial`.

**Rule: Candidate rows.** The client decodes `output` into rows, drops duplicates, and replaces the last word before the cursor. It does not request completion while the cursor is inside an open quote or in the middle of a word.

**Rule: Accept does not execute.** Tab accepts ghost text when ghost text is showing. If a dropdown row is highlighted, Tab accepts that row instead, and the ghost tracks the highlighted row. A click on any row accepts that row. Right at the end of the buffer accepts ghost text. None of these run the command. After an accept, the dropdown and ghost are gone before the next key. Tab with neither ghost nor an open dropdown, and with no in-flight request for this context, only requests completion. It does not insert a tab and does not move focus.

**Rule: The draft stays editable.** Completion code does not write the buffer. Keystrokes that change the draft or the cursor apply immediately and invalidate the in-flight result. When the attempt ends, the buffer is that current draft.

```gherkin
Scenario: Typing requests one completion and keeps the draft
  Given automatic completion refresh is on
  And the shell is trusted AtPrompt
  And the user has typed "git sta"
  When the coalesce window elapses
  Then one completion RPC is started for that revision and cursor
  And the buffer remains "git sta"
  And xterm scrollback does not show the generator or its output
  And the composer stays mounted

Scenario: Repeated Tab keeps the same request
  Given a completion request is in flight for the current revision and cursor
  And no ghost text and no dropdown are showing
  When the user presses Tab
  Then the key is consumed
  And the same request keeps running
  And no second generator starts
  And the draft is unchanged

Scenario: A cursor move invalidates and coalesces one replacement
  Given a generator is active for revision 4
  And automatic completion refresh is on
  When the user moves the cursor
  Then revision 4's result can no longer apply
  And at most one replacement is recorded for the new cursor
  And that replacement starts only after the active generator finishes or is cancelled

Scenario: Refresh off waits for an explicit request
  Given automatic completion refresh is off
  And a generator is active
  When the user types "t"
  Then the previous result is invalidated
  And no replacement is scheduled
  When the user later presses Tab and nothing is showing
  Then one request is scheduled for the latest context

Scenario: A stale response is ignored
  Given request A was superseded by request B
  When a result for request A arrives
  Then the editor ignores it
  And the draft is unchanged

Scenario: Generator timeout leaves the draft
  Given the buffer is "git sta"
  When the generator exceeds its timeout
  Then the draft is still "git sta"
  And the composer stays mounted
  And no history entry is added

Scenario: A completer that cannot restore state is not used
  Given a provider would change CWD or the environment and the wrapper cannot contain it
  When completion is requested
  Then that provider is not started
  And the draft is unchanged
  And another eligible provider may still return results

Scenario: Tab accepts the highlighted row
  Given the buffer is "git rem"
  And the highlighted row is "git remote"
  And the ghost text tracks that row
  When the user presses Tab
  Then the buffer becomes "git remote"
  And the command is not run
  And the dropdown and ghost are cleared
```

### Story: Editor keys, history, and chips

> As a person editing a command, I want the editor's keys to edit the draft, so that app shortcuts and the shell do not fight.

**Rule: App shortcuts win on every platform.** `commandPalette` and `commandHistory` keep their configured bindings. Keys that are not app shortcuts edit the buffer, including Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U, and Ctrl+W when they are not the active shortcut. Browser shortcuts the page cannot override stay with the browser.

**Rule: Layers for Up and Down.** An open completion dropdown takes them. Else an open history popup takes them. Else they move the caret between visual rows, soft-wrapped rows included. Only on the first visual row does Up recall the previous history entry with the same prefix; the prefix is the text of the first logical line. Only on the last visual row does Down move toward newer history and then restore the unsent draft. The caret's visual row is the row it is drawn on: at a wrap boundary the caret's side (`assoc`) decides between the end of one row and the start of the next. An empty buffer recalls the previous command with no prefix filter, and does not execute it.

**Rule: Esc and Ctrl+C and Ctrl+D.** Esc closes the dropdown or history popup and clears ghost text. The buffer is unchanged. Esc is not written to the PTY. Ctrl+C copies and leaves the buffer when xterm has a non-empty selection. Otherwise Ctrl+C in the editor clears the buffer and sends nothing. Ctrl+D on an empty buffer leaves the editor and sends EOF. Ctrl+D at the end of a non-empty buffer does not send EOF and does not delete. Ctrl+D in the middle deletes the character under the cursor. Shift+Enter inserts a newline. Uncommitted IME text is not in the buffer and does not submit.

**Rule: IME and the stored draft.** The stored draft holds committed text only. While a composition is open, its document changes are not offered to the draft store. When the composition ends, committed or cancelled, by a DOM `compositionend`, by the editor's deferred flush after `compositionend` (Android Chrome), or by an EditContext update with no DOM composition event, the store gets the final committed document once, after that flush has landed. A cancelled composition leaves the store at the last committed text. The editor does not stay composing after the composition has ended, so the next ordinary edit is stored. Nothing is stored after the editor is destroyed; a remount restores the last committed draft.

**Rule: Paste and foreign insert.** Editor paste stores visible text only. Drop ESC, NUL, and other C0 controls except newline and tab. Do not store bracketed-paste wrappers. Newlines stay in the buffer. Nothing runs until Enter. Image paste does not write `0x16` and does not change the buffer. History-modal or assist text that contains a newline or other control character is refused in the editor: the buffer is unchanged and the PTY is not written. In PTY mode the current control-character refusal and PTY insert remain. A history-popup Enter fills the buffer, closes the popup, and does not run it.

**Rule: Mobile.** In the editor the key bar does not call `terminalApi.write`. Arrows, Tab, Esc, Ctrl+C, and paste follow the editor rules. Page Up and Page Down scroll xterm and do not write. In PTY mode the bar keeps today's direct writes, except a view-only client writes nothing.

**Rule: Chips.** The CWD chip and the git branch chip show `Terminal.cwd` and `Terminal.gitBranch`. They may stay stale until the existing poll. A missing value hides that chip. Completion does not use the chip. It uses the CWD from the last authenticated PromptReady. Windows with no CWD hides the chip and can still enter the editor on a valid prompt. A session whose PromptReady has no CWD skips completion. A later metadata update changes the chips without leaving the editor.

**Rule: Exit code.** `CommandFinished` with a code updates the last exit code. Without a code, the previous code stays. A duplicate of the same code does not clear it.

```gherkin
Scenario: History recall does not execute
  Given the editor is on the first visual row
  And the buffer is empty
  And the previous history entry is "git status"
  When the user presses Up
  Then the buffer becomes "git status"
  And the command is not run

Scenario: Ctrl+R still opens the app history
  Given commandHistory is ctrl+r
  When the user presses Ctrl+R in the editor
  Then the app history UI opens
  And ctrl+r is not sent to the PTY

Scenario: Editor paste does not run
  Given the user pastes "echo hi\necho there"
  When the paste is stored
  Then the buffer contains both lines
  And nothing is written to the PTY until Enter

Scenario: Up on a wrapped row moves the caret
  Given the buffer is one long line soft-wrapped onto two visual rows
  And the caret is on the second visual row
  When the user presses Up
  Then the caret moves to the first visual row
  And the buffer is unchanged

Scenario: Up at the end of the first visual row recalls history
  Given the buffer is the long line L soft-wrapped onto two visual rows
  And the caret sits at the wrap boundary, drawn at the end of the first visual row
  And the previous history entry is L followed by " --amend"
  When the user presses Up
  Then the buffer becomes L followed by " --amend"
  And the command is not run

Scenario: A deferred IME flush is stored once
  Given an IME composition of "日本" is open
  When compositionend fires and the editor flushes the final text on the next frame
  Then the stored draft is unchanged before the flush
  And the stored draft is "日本" after the flush
  And the next typed character is stored
```

### Story: Remote authority and focus

> As a shared-live participant, I want input authority to match what I am allowed to do, so that a viewer cannot drive the host shell.

**Rule: View-only.** A view-only client never mounts the composer, never submits, never starts completion, and sends no bytes, including the mobile key bar. Its scrollback is the host PTY stream: prompt suppressed, the submitted command echoed once, then output. The host's unsent draft is not shown.

**Rule: Two writable clients.** Each keeps a local buffer. Enter submits only that client's buffer. The other client's unsent draft stays local and returns when that client next enters the editor. There is no shared caret. The host allows one in-band generator for the PTY. The other client's request is not started, and that client's draft is unchanged. It may request again only after the PTY is `AtPrompt` and no generator is running.

**Rule: Focus.** Showing a live pane again after a project switch mounts the editor immediately when that session is already a valid prompt, and keeps that terminal's unsent draft. A prompt on a background terminal does not steal keyboard focus. Only the focused visible terminal focuses its composer. The PTY process is not killed.

```gherkin
Scenario: A viewer cannot complete or submit
  Given a shared-live client is view-only
  When that client presses Tab or Enter or a mobile-bar key
  Then no completion RPC is sent
  And no bytes are written to the PTY
  And the composer is not mounted

Scenario: Two writers do not share a generator
  Given two writable clients are attached to the same PTY
  And client A has an active generator
  When client B requests completion
  Then client B's generator is not started
  And client B's draft is unchanged
```

---

## Acceptance Criteria

```
ACCEPTANCE CRITERIA — native command editor
Date: 2026-10-20 | Scope confirmed: yes

Rule: Trusted prompt
  ✓ Given a handshake and an authenticated suppressed empty prompt, When it is applied, Then the empty composer mounts and the shell glyph is hidden
  ✓ Given ambient OSC 133 or __TERMUL_EXIT__, When it arrives, Then the mode does not change
  ✓ Given prompt_suppressed is false, When PromptReady arrives, Then the session stays raw
  ✗ Given the integration is lost while a draft exists, When the session falls back, Then the draft is not executed

Rule: Submit once
  ✓ Given buffer "git sta" and highlight "git status", When Enter is pressed, Then "git sta" is written once and history stores "git sta"
  ✓ Given a pending completion, When Enter is pressed, Then the generator is drained or cancelled, replacements are suppressed, and the draft is submitted once
  ✓ Given a pre-write failure on a trusted prompt, When submit returns, Then the editor and draft return and history is unchanged
  ✗ Given write_all or flush fails after bytes may have been written, When submit returns, Then the editor stays down and no history is written

Rule: Completion scheduling
  ✓ Given an in-flight request for the same revision and cursor, When Tab is pressed and nothing is showing, Then that request keeps running
  ✓ Given a draft or cursor change while pending and refresh on, When the edit happens, Then the old result is invalid and at most one replacement runs after the generator is safe
  ✓ Given refresh off, When the draft changes, Then no replacement starts until the next explicit request
  ✓ Given a result whose session, mode, revision, cursor, or shell context does not match, When it arrives, Then it is ignored
  ✗ Given a view-only client, When it requests completion, Then the host does not start a generator

Rule: Accept does not execute
  ✓ Given ghost text or a highlighted row, When Tab or a row click accepts it, Then the buffer changes and the command does not run
  ✓ Given an open dropdown, When Enter is pressed, Then the buffer text is submitted

Rule: Editor isolation
  ✓ Given Editor mode, When the user pastes, uses the mobile bar, or inserts assist text, Then the PTY keystroke path is not used
  ✓ Given a TUI or a running command, When the user types, Then xterm and the PTY receive the input and the composer is gone
  ✓ Given an open IME composition, When it ends by any path, Then only the committed text is stored and the next edit is stored
  ✓ Given the caret on a soft-wrapped row that is not the first visual row, When Up is pressed, Then the caret moves and history is not recalled

Rule: Surfaces
  ✓ Given desktop, termul-server, and the browser, When the same prompt and submit occur, Then the observable mode, echo, and completion rules match
  ✓ Given a project switch, When a live prompt pane is shown again, Then its PTY is alive and its unsent draft is still there
```

---

## Design Decision

**Chosen option:** Option A — Termul session protocol with in-band completion.

**Summary:** The host injects an original bash or zsh integration for a local interactive login shell. The shell reports lifecycle on a private channel bound to a host-generated session id and nonce. The PTY reader strips that channel from the output bytes, in the same pass family as `DaFilter`, and drops the protocol bytes instead of forwarding them. The editor is CodeMirror. Completion is a host RPC that runs one wrapped generator in that shell and returns a structured result to the caller. Submit is a different host RPC that serializes behind the same generator lock.

**Rejected options:**

- Option B — VS Code OSC 633 for lifecycle, and completion from a filesystem and executable scan outside the PTY. Rejected because the completion scenarios require aliases, functions, shell config, and session context. Ambient OSC 633 is also forbidden as a mode signal.
- Option C — a second PTY for completion. Rejected because it is a different shell session. It misses the interactive shell's functions, options, and current directory.
- Option A variant — parse the protocol only with xterm `registerOscHandler`. Rejected because the handler runs after bytes are already the terminal parser's problem, payloads can split, the limit is 10 MB, and shared-live subscribers would still see the raw stream unless the host strips it.

**Key tradeoffs accepted:**

- In-band completion can disturb the shell if the wrapper is wrong. The contract fails closed to "do not run this provider" or raw mode.
- The host RPC is new surface area on both transports. Reusing `terminalApi.write` would replay submits and leak generator bytes.
- CodeMirror's default keymap would submit the highlight on Enter. It is turned off, and the editor owns Tab, Enter, Esc, and arrows.
- Prompt suppression depends on the integration staying last in the shell's prompt hook. If it cannot prove suppression, that session stays raw.

### Protocol shape

Original names, not copied from another product:

- `InitShell` registers `session_id` and nonce. The client enables the protocol only after the host has registered that session. Until then the shell prompt stays the normal prompt.
- `PromptReady` carries nonce, prompt generation, `line_empty`, `prompt_suppressed`, and the CWD the shell believes. Duplicate `PromptReady` while already in Editor with an unsent draft is ignored.
- `CommandStarted` comes from Preexec of a user command. A generator sets an internal flag so its Preexec does not emit this and does not change mode.
- `CommandFinished` carries the exit code captured at the start of the same shell function that announces completion of the user command. A generator does not emit a user `CommandFinished`.
- Completion output is the RPC payload, not a lifecycle hook that every viewer applies.

The private OSC or DCS ident is one constant. It is not 133, 633, or 9278. The exact number is chosen in implementation and covered by a test that the reader strips it. A malformed, oversized, or split frame that cannot be parsed is discarded. It does not change the draft. If the stream can no longer be resynchronized, the session falls back to raw.

Exactly-once echo:

1. While integrated, the visible prompt is a zero-width marker sequence, re-applied idempotently at the end of the prompt hook.
2. Before the command bytes, a dedicated binding clears the shell line editor on every keymap that shell may be using.
3. The host writes the draft once while holding the PTY writer lock.
4. The shell's normal echo paints that one line. The client does not paint it again.

### Modules

New behavior is new files. An existing file keeps its current shape and gains only the wiring below.

- `src-tauri` session protocol filter and sibling tests, as new files. `reader_loop` gains a call before bytes are queued for clients. The filter does not replace `DaFilter`, and `spawn.rs` is not split.
- Host RPC for submit, completion start, and completion cancel. `TerminalApi` gains the method signatures. The Tauri and web implementations delegate to new modules. The web path uses a live correlated request. It does not use `inputBuffers`. `web-terminal-api.ts` is not reorganized.
- Renderer coordinator, as new files, for the phase machine: `Unknown`, `AtPrompt`, `Submitting`, `Executing`, `Terminated`, plus `CompletionPending` under `AtPrompt`. A pure transition function decides; it does not mutate on an unproven hook. Duplicate and unregistered hooks are ignored. `ConnectedTerminal.tsx` only mounts the editor and chooses the editor or the existing xterm key path. It does not absorb the coordinator, and it is not split.
- CodeMirror command editor, as new files: buffer, ghost decoration, autocomplete tooltip, history popup, chips. `autocompletion({ override, defaultKeymap: false, activateOnTyping: false })`. The coordinator decides when a request starts. The library renders the latest valid result. `selectOnOpen` stays at its default so the first row and the ghost match.
- Shell assets for bash and zsh only, installed for a local interactive login shell (`shell_wants_login_arg` already supplies `-l` for bash and zsh). Failed bootstrap leaves a normal shell and the session stays raw.
- Parity coverage in the existing renderer parity checklist for the new facade methods.

### Preference

`automaticCompletionRefresh` defaults to true. Place the control in the existing app-preferences pattern. Do not create a new settings architecture.

---

## Open Questions / Assumptions

| Question | Resolution | Risk if Wrong |
|---|---|---|
| Independent edge-case review of the last Tab intersection | The user closed it on 2026-10-20 and authorized design and spec without another review. Repeated identical Tab keeps the current request. Context changes invalidate. | A later review could still find a case outside these five rules |
| Default for automatic refresh | Assumed on, with an off preference | Users who want Tab-only completion must find the preference |
| Completion timeout duration | About 1.5s on the host in one named constant, plus the existing 2s drain bound. Timeout behavior is fixed: draft unchanged, editor stays, generator cancelled or drained, no history, no mode change, and a `TimedOut` reply only after the shell is free | A poor bound makes completion feel stuck or too eager. It must not change the invariants |
| Private OSC ident | One new constant, not 133, 633, or 9278 | A collision with a program the user runs would force raw fallback for that session |
| Third-party completer containment | UNVERIFIED until the wrapper exists. Uncontained providers are not run. A failed restore falls back when trust is gone | An escaped side effect can force raw mode |
| 100ms idle coalesce | Assumed from the installed autocomplete default, used only when no generator is active | Too slow or too fast changes how soon ghost text appears. It must not overlap generators |

---

## Implementation Notes

- Do not log command text, paste contents, env values, or completion payloads.
- Shell scripts are original. Do not copy warpdotdev/warp sources into the tree.
- `CommandStarted` observed from the shell is the command that actually started. The local editor is the submitted draft, not a second source of truth after the host has accepted the write.
- A future output-block renderer may subscribe to `PromptReady`, `CommandStarted`, and `CommandFinished`. This spec does not render blocks.
- Do not split, move, or reorganize an existing file in this PR. Keep each existing-file hunk to wiring. If a new file approaches about 800 production lines, split that new file into new files, then search the new symbols for orphaned imports.
- Boundary logs for failed submit, integration loss, and raw startup name the mode change and the failure class.

---

## Rollback Plan

- A session whose handshake or prompt suppression is not trusted never mounts the editor and never hides the prompt. That session is the current raw terminal.
- Disabling injection at spawn returns every new local shell to today's PTY pipe. Existing live sessions fall back to raw when their integration is lost.
- No migration. Unsent drafts live in memory for the terminal pane. A process exit drops them.
- The new preference defaults to current-target behavior (refresh on) once the editor exists. Turning the preference off stops automatic generator refresh and leaves explicit Tab.
