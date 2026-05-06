# xterm 6.1 Manual Validation Protocol

## Purpose

This protocol supports Epic 3 Story 3.3 by documenting the manual-only workflows that must be exercised before xterm 6.1 can be considered ready to replace the 5.5 baseline.

## Preconditions

1. Stay on branch `feat/xterm-6.1-migration`.
2. Keep the production default path on xterm 5.5.
3. Enable the 6.1 validation posture only through the opt-in canary path:
   - environment key: `VITE_XTERM_MIGRATION_CANARY`
   - accepted enable values: `xterm-6.1`, `true`, `1`, `on`
4. Have a known-good 5.5 baseline session available for side-by-side comparison.

## Recording Rules

For every scenario below, capture:
- date/time
- reviewer name
- whether the canary path was enabled
- expected result
- actual result
- severity: acceptable / warning / blocked
- rollback needed: yes/no
- notes and screenshots if relevant

If any scenario is worse than the 5.5 baseline in a user-visible way, record it as an adoption blocker unless the Story 3.4 gate explicitly allows that category to remain warning-level.

## Scenario 1: IME Composition

### Steps
1. Start Termul with the 6.1 canary enabled.
2. Focus a terminal prompt.
3. Use a representative IME input method.
4. Type a short phrase with intermediate composition candidates.
5. Confirm the phrase.
6. Repeat inside an interactive CLI prompt if available.

### Expected outcome
- composition window appears normally
- intermediate composition text is stable
- confirmed text is inserted once
- cursor position remains correct

### Failure signals
- missing or duplicated characters
- broken candidate popup behavior
- committed text inserted in the wrong place
- cursor jumps or flickers relative to the 5.5 baseline

## Scenario 2: vim Alternate-Screen Workflow

### Command
```bash
vim README.md
```

### Steps
1. Enter vim.
2. Move around the file.
3. Enter insert mode and type a small change.
4. Resize the window while vim is open.
5. Exit vim without saving if desired.

### Expected outcome
- screen enters alternate-screen cleanly
- redraws remain intact during navigation and resizing
- cursor placement remains stable
- exiting returns to the shell without visual corruption

### Failure signals
- stale screen fragments
- redraw corruption
- incorrect cursor position
- broken resize behavior
- shell prompt not restored correctly after exit

## Scenario 3: fzf Interactive Filtering

### Command
```bash
fzf
```

### Steps
1. Launch fzf.
2. Type a few characters to filter.
3. Move selection up/down.
4. Clear the query and repeat.
5. Cancel out of fzf.

### Expected outcome
- filtering remains responsive
- selection highlight updates correctly
- no redraw glitches while typing or navigating

### Failure signals
- input lag relative to 5.5
- stale rows / redraw artifacts
- broken selection movement
- corrupted prompt on exit

## Scenario 4: lazygit Navigation and Resize

### Command
```bash
lazygit
```

### Steps
1. Launch lazygit.
2. Navigate across panels.
3. Trigger a view that redraws frequently.
4. Resize the Termul window while lazygit is active.
5. Exit lazygit.

### Expected outcome
- panel redraw remains correct
- navigation remains responsive
- resize does not corrupt panel layout
- exit returns cleanly to the shell

### Failure signals
- missing or stale panels
- keyboard navigation glitches
- broken resize rendering
- stuck alternate-screen state after exit

## Scenario 5: Agent CLI Streaming Output

### Steps
1. Launch a representative agent CLI that produces sustained streaming output.
2. Let output stream for a noticeable interval.
3. Switch to another project/tab and return.
4. Try selecting/copying text from the session.
5. Repeat once with the canary disabled on the 5.5 baseline for comparison.

### Expected outcome
- streaming output remains readable
- switching away and back does not degrade continuity versus 5.5
- selection/copy still behaves as expected

### Failure signals
- missing streamed content
- broken replay after switching projects
- unusable redraw during streaming
- selection/copy regressions during or after streaming

## Rollback Rule

If any scenario is marked `blocked`:
- disable `VITE_XTERM_MIGRATION_CANARY`
- return to the 5.5 baseline path
- record the blocker in the Story 3.3 validation artifact and carry it into Story 3.4 adoption-gate work
