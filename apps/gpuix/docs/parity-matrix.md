# GPUIX parity matrix

This page measures how close the GPUIX desktop client is to the DOM web
client, one user-facing surface at a time. Every number on it comes from
`bun run parity:matrix`, which drives both clients through the same steps
against one seeded `termul-server` and records what each client painted and
did. The tables between the `matrix:begin` and `matrix:end` markers are
generated. The prose around them is written by hand from the PNG pairs.

## Run it

```sh
bun run build:web                        # at the repo root: the web client under test
cd apps/gpuix
bun run parity:matrix                    # every surface, about 50 minutes
bun run parity:matrix --only git.diff,chat.send
bun run parity:matrix --area terminal
bun run parity:matrix --report-only      # regenerate this page from results.json and review.ts
bun tools/matrix/probe.ts <surface-id>   # web only: what the DOM offers to act on, per step
bun tools/matrix/pair.ts [surface-id]    # web | GPUIX side by side, for review
```

To measure what the `.deb` ships, run GPUIX on the self-built patched addon
([native-patches.md](./native-patches.md)): `bun run native:build`, then
export `NAPI_RS_NATIVE_LIBRARY_PATH=$PWD/native/gpuix-native/build/gpuix-native.linux-x64-gnu.node`
before the run. The canvas surfaces need the pinned FigCraft bundle and the
webview helper in `dist/` (`bun run build:webview-host`):

```sh
TERMUL_SERVER_BIN=$PWD/tools/canvas/server-with-bundle.ts \
FIGCRAFT_BUNDLE_DIR=/tmp/gpuix-<unit>/figcraft-bundle \
  bun run parity:matrix --only canvas.open,palette.open-canvas
```

Output goes to `parity-out/matrix/<surface>/<step>/` (`web.png`, `gpuix.png`,
`diff.png`, the region crops and `pair.png`) and `parity-out/matrix/results.json`.
A partial run updates only the surfaces it ran. `results.json` and the PNGs
are not committed (`parity-out/` is ignored); this page is the record. A
surface missing from `results.json` keeps the status, measured columns and
interaction lines this page already shows for it, so a partial run in a fresh
checkout does not blank the rest. Server and client state live
under `/tmp/gpuix-m1` (`--state` or `GPUIX_STATE_ROOT` moves them) and are
deleted at the start and end of the run, so keep `--out` outside
`<state>/matrix`.

## What a run does

1. `world.ts` starts one test server on a free port in 8190-8199 and seeds
   it. alpha is a git repo with three commits, a second branch
   (`feature/login`), a staged edit (`src/app.ts`), an unstaged edit
   (`README.md`) and an untracked file (`notes.txt`). beta, gamma and delta
   are plain folders. A chat in alpha holds the scripted agent's three turns
   (`tools/chat/scenario-agent.ts`): prose, code, a table, mermaid, tool
   calls, thoughts and an edit with a diff. The agent runs behind
   `tools/matrix/agent.ts`, which answers three more prompts itself:
   `matrix plan` (a plan update), `matrix permission` (a tool call that asks
   for permission) and `matrix hold` (a turn that stays open, so the next
   prompt queues).
2. Each surface in `surfaces/` runs in the web client (Playwright chromium,
   1280x800, dark, reduced motion) and then in GPUIX (Xvfb, lavapipe,
   automation). Both start on the dashboard as a fresh device, so per-device
   UI state never leaks between runs. A surface's `prepare` re-seeds what an
   earlier run changed (git state, a renamed or deleted project, the theme).
   Before each client run the matrix also closes every terminal the server
   still preserves (`terminals.ts`), so the server's limit of 10 terminals
   per project never stops a later surface.
3. Every action is logged with how GPUIX found its element. `testid` and
   `text` mean GPUIX resolved it natively, picking the match nearest the
   point where the web client acted. `web-point` means it clicked where the
   web client painted that element, which happens for targets only the DOM can
   name (accessible labels, CSS selectors) and for native lookups that found
   nothing. A drag onto a pane spot (`frac` of `[data-pane-content]`) runs as
   mouse steps on the web, so the HTML5 drag reveals the pane's drop zones
   before the pointer reaches them; other drags use Playwright `dragTo`.
4. A check passes when its text is painted. On the web that means
   `innerText` of the page or of the `within` test id. On GPUIX it means a
   node's text or the joined tree text (`getAllText`, because
   `getPaintedText()` is empty on Linux). An ordered check asserts a list
   order after a drag.
5. One frame is grabbed per step in each client. `diff.ts` counts exact and
   perceptual (pixelmatch 0.1) mismatches for the full frame and for the
   surface's region.

## Statuses and scores

| Status | Meaning |
| --- | --- |
| ported | Every action and check passes in GPUIX, and the pair shows no difference a user would notice beyond font rasterization. |
| partial | The interactions work, but the pair shows visible or behavioral differences. |
| broken | An action or check that passes on the web fails in GPUIX, or GPUIX shows the wrong thing. |
| blocked | There is no web reference to compare (a Tauri-only surface), or a missing platform capability stops it. |
| pending-unit | Waits on another unit (named in the table). |
| unverified | The web reference itself failed; the harness needs work before the surface counts. |

The automatic status in `results.json` only knows the checks and a 2 %
perceptual threshold on the region. The reviewed status in `review.ts` comes
from looking at every pair and overrides it.

A surface scores 1 when ported, 0.5 when partial and 0 otherwise. The
unweighted score is the mean over surfaces. The usage-weighted score gives
each area a weight (`weights.ts`, summing to 100), averages the surfaces
inside an area, and weights the area means.

The weights follow what a Termul user does all day. Agent chat is the
product's centre, so chat (17) and the composer that feeds it (14) carry the
most. The terminal (14) is the other primary work surface. The project rail
(9) and git changes (9) are touched many times an hour, the explorer (7) and
the editor (7) a little less. The side panel (5), settings (4), status bar
(3) and palette (3) are daily but brief. Themes (2) are set once and seen
always. Shortcuts, dialogs, toasts and the browser pane get 1 each, and the
canvas, SSH, remote access and snapshots get 0.5 each because few sessions
open them. Settings has 13 sections, so a per-surface weight would let it
dominate; weighting by area avoids that.

## Findings

**G6 rerun.** The generated tables now come from G6's full run on
`gpuix/g6` (2026-10-25), on the self-built addon with patch `gpuix/0008`
(`bun run native:patch-check` passed 11 of 11 first), the worktree's own
`bun run build:web`, and `tools/canvas/server-with-bundle.ts` with the pinned
FigCraft bundle for every surface. palette.save-snapshot lost a GPUI key
command once under load (1-minute load average up to 22 while a sibling
unit ran) and matched on a rerun. Against M2's run the reviewed count went
from 70 to 85 ported and the usage-weighted score from 71.7 % to 76.3 % over
all surfaces. G6 closed these gaps:

- Focus styles on fields. A focused text field paints `focus-visible:` in
  the frame it gains focus (native patch `gpuix/0008`); a native field's
  focus bubbles to its compat ancestors and the ui Box tracks
  `focus-within:`, so the popover search bands ring; an outer ring paints as
  an outline, so the focused status-bar branch button is no longer filled;
  an inset ring sits inside the border. The composer still lacks its focus
  border: its native textarea and key-capture div emit no focus events
  (composer.mention, composer.slash).
- Settings dividers: `divide-x`/`divide-y` in the style layer.
- The Accounts skeleton and the composer after a project switch were the
  frame grab racing a slower GPUIX, not wrong state. The steps now wait for
  the loaded state, and every check records its wait (`ms` in
  `results.json`).
- The collapsed rail's Open canvas button: a column `mt-auto` wrapper no
  longer takes half the space of a `flex-1` sibling.
- The FigCraft page colour: the webview helper starts on the dark GTK theme
  when Termul is dark.

The rest of this section is M2's account of its run, kept for its
diagnoses; its numbers are M2's.

Every row below comes from one head, 89047fd5 on `exp/gpuix-client`, run by
M2 on 2026-10-25. GPUIX ran on the self-built patched addon
(`bun run native:build`, then
`NAPI_RS_NATIVE_LIBRARY_PATH=native/gpuix-native/build/gpuix-native.linux-x64-gnu.node`),
the build the `.deb` ships, and `bun run native:patch-check` passed all 11
checks on it first. The web client was the worktree's own `bun run
build:web`. The window was active (the harness default). The full run took
51 minutes. The canvas surfaces ran afterwards with
`TERMUL_SERVER_BIN=tools/canvas/server-with-bundle.ts` and the pinned
FigCraft bundle, whose zip hashed to the sha256 in `canvas/figcraft.pin`.
Surfaces that differed for a reason that might be the harness ran up to two
more times. Every pair was looked at before it was classified.

No other unit ran; an idle V1 test server stayed up on port 8194. Over
the full run the 1-minute load average, sampled every 30 s, had a median of
6.3 and a maximum of 11.0 on 8 cores. The matrix itself (Bun, Chromium, Xvfb
and lavapipe) accounts for most of that. The codebase-memory indexer, which
this unit does not control, was among the top three processes in 14 of the
154 samples taken across the session.

**Where it stands.** 116 surfaces: 70 ported, 36 partial, 3 broken, 7
blocked. The usage-weighted score is 71.7 % over all surfaces and 74.0 %
over the 109 measured ones. Unweighted, it is 75.9 % and 80.7 %. By area,
the terminal, explorer and status bar are at 100 %, themes at 97.6 %, the
side panel at 90 %, the editor at 87.5 %, the palette at 86.4 %, git at
83.3 % and the rail at 75 %. Settings (57.1 %), chat (55.6 %) and the
composer (33.3 %) hold the score down, and chat and the composer carry the
most weight.

These numbers are lower than the 83.4 % the page showed before, for two
reasons. The first is a stricter review. Earlier reviews let a missing focus
ring pass as ported; this one counts it as partial, because a user does see
whether the field they type into is highlighted. The "focus styles on fields" unit below covers 11 partial surfaces, most
of which differ only in that border, and would win back 7.3 points. The second is that one head shows defects that runs on
many heads hid. Attach files fails in GPUIX, the queued-prompt chat renders
wrong in 3 of 3 runs, the collapsed rail lost its canvas button, the
Accounts section never loads, and settings groups lose their dividers.

The native patch series closed the two largest gaps of the previous page.
Backdrop blur (N2) now matches the web on every modal, so the
Project settings, palette, Preferences and Create Snapshot surfaces that
were partial for the sharp page behind the scrim are ported. Chat prose
(N1, N2) paints links in primary with their underline, inline code in the
smaller padded chip, and real italics.

**Ranked remaining gaps.** The generated tables below rank every gap. By
the usage-weighted points each unit would win back:

1. Focus styles on fields, a compat translator gap: +7.3 over 11 surfaces.
   The composer, popover search bands, the theme search and the bug report
   title show a caret but no focus border. G5 recorded these borders in
   GPUIX, so this regressed since G5. A candidate cause is gpui's rule that
   `focus_visible` styles apply only after keyboard input; it is not traced.
2. Attach files, a native override: +4.7. Outside Tauri the composer opens
   a DOM file input, which GPUIX cannot show, and GPUIX answers with "Failed
   to open file picker". GPUIX has `promptForPaths` for this.
3. The rest of the chat prose, a native override: +2.8 over 3 surfaces.
   Task-list boxes draw as text glyphs, a paragraph with inline code wraps
   about 60 px wider than the web column, and the table card lacks its
   expand button and splits its columns differently.
4. The queued-prompt chat, needs diagnosis: +1.9. In GPUIX the transcript of
   a chat started from the launcher stays empty, or the follow-up is sent
   instead of queued.
5. Confirm dialog stacking, a compat translator gap: +1.0. The web keeps the
   status bar above ConfirmDialog's inline scrim by DOM order; GPUIX puts
   the fixed overlay on top.
6. Smaller units of about +0.9 each: Mermaid as source (a missing GPUIX
   capability), the composer's agent pick after a project switch (needs
   diagnosis), settings `divide-y` (compat), the agent chip in the agent
   popover (C2), the plan card's ring and chevron (compat) and markdown
   preview spacing (E2). The collapsed-rail canvas button, title tooltips,
   the Accounts list, the canvas theme handoff, the agent registry list in
   settings and four more follow with 0.1 to 0.5 each.

**What 99 % parity requires.** On the usage-weighted score, 99 % allows
losing about one point of the 100 weight. If every unit in the table fixed
every surface it names, the score would be 97.8 %. The remaining 2.2 points
are surfaces with no web reference: the browser pane (1.0), SSH (0.5),
Claude accounts (0.29 of settings), the snapshots page (0.25) and the
desktop keymap (0.14 of shortcuts). GPUIX has a browser pane and SSH; the
matrix cannot score them against a web client that has neither. Three kinds
of work reach 99 %.

1. Land the units in the order above. The focus-style, attach and prose
   units are worth 14.8 points together, more than all others combined.
2. Diagnose the four "needs diagnosis" gaps first among the small ones,
   because each may be a functional bug rather than a cosmetic one: the
   queued-prompt transcript, the Accounts skeleton, the composer agent
   pick and the missing collapsed-rail button.
3. Give the reference-less surfaces a reference: a Tauri screenshot
   harness, or a GPUIX-only functional check (R2's SSH run is one) that the
   matrix accepts as the score.

Ninety-nine percent also means every partial surface reaches ported, so the
cosmetic units count even when no single one looks important.

**Flakes.** A surface that differed in the full run and matched on a rerun
is recorded here and scored from its matching run. A surface that differed
in every run is a gap above, not a flake.

| Surface | Runs that differed | What happened |
| --- | --- | --- |
| `terminal.open` | 1 of 2 | The GPUIX frame was grabbed before the prompt painted. |
| `terminal.split` | 1 of 2 | Harness: both clients hit the server's 10-per-project terminal limit, because preserved PTYs from earlier surfaces piled up. Fixed in `tools/matrix/terminals.ts`, which closes them before each client run. |
| `palette.new-terminal` | 1 of 2 | Harness: the same terminal limit, in both clients. |
| `terminal.tab-reorder` | 2 of 3 | The terminal limit in the full run; then the GPUIX click on Bash in the just-opened New tab menu was lost once. |
| `palette.app-preferences` | 2 of 3 | GPUIX crashed with the automation bounds-query timeout (C13) once, and grabbed the Interface rows laid out narrow once (the container-query first frame). |
| `canvas.open`, `palette.open-canvas` | 1 of 2 | Harness setup: the full run had no FigCraft bundle and no webview helper in this worktree's `dist/`. The canvas run had both. |

Gaps that repeated on every rerun: `chat.queue` (3 of 3),
`settings.provider` (3 of 3), `composer.attach` (2 of 2) and the beta
composer not ready after a switch in `rail.project-list` (3 of 3) and
`palette.switch-project` (2 of 3). The same race shows on the dashboard
frames of the theme surfaces: 7 of 20 GPUIX frames and 2 of 20 web frames
show Loading model…, Composer unavailable or another agent. The theme rows
stay ported because their colours match.

**G4 and the keymap.** Since G4 the GPUIX client takes the desktop keymap, like
Tauri: Ctrl+, opens Preferences and Ctrl+= zooms, and the web's Alt+, and
Alt+= do nothing. The shortcuts.settings-shortcut and shortcuts.zoom-in steps
press each client's own key (G3). `tools/parity/workspace-checks.ts` and
`tools/parity/zoom-check.ts` check the same keys outside the matrix.

**Terminal query replies after vim.** The O1 note said GPUIX echoed terminal
query replies (`^[[>0;276;0c ... rgb:`) into the prompt after its T1 fixture
ran vim. Both clients ran the fixture's own command, `vim -u NONE -N
notes.txt` and then `:q!`, typed into the full app. Both returned to a clean
prompt with no echoed replies, again in this run. It is most likely a
fixture artifact, because the fixture writes its inputs to the PTY back to
back (inferred; the fixture was not rerun). It is not counted as a gap.

**How far to trust a row.** GPUIX text checks read the automation tree.
Natively painted text (chat prose, the editor, terminal cells) is not in that
tree, so those checks fail even when the text is on screen. Those rows were
decided from the PNG pairs. The automatic status in the table is the
harness's own guess and is often wrong in both directions; the reviewed
status is the one that counts.

**Not covered.** The matrix does not drive these, so they are not scored.

- Settings toggles and inputs inside each section. Only navigation and
  content are compared.
- The new project modal's fields after it opens, and folder groups.
- Git stash, history view, and conflict resolution.
- Editor save, Source mode editing in markdown, and big files.
- Composer pills with real files, because a bare @ lists no files on this
  server in either client.
- Panel divider resize. D1 reports that it works and persists the size.
- The mobile layout, the snapshots page and what's new.

<!-- matrix:begin (generated by `bun run parity:matrix`; edit tools/matrix/review.ts, not this block) -->

Surfaces: 116 (ported 85, partial 22, broken 2, blocked 7, unverified 0, pending-unit 0).

| Score | All surfaces (pending, blocked and unverified count 0) | Measured surfaces only |
| --- | ---: | ---: |
| Unweighted | 82.8% | 88.1% |
| Usage-weighted | 76.3% | 78.9% |

### By area

| Area | Weight | Surfaces | Ported | Partial | Broken | Blocked, pending or unverified | Area score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chat | 17 | 9 | 2 | 6 | 1 | 0 | 55.6% |
| composer | 14 | 3 | 0 | 2 | 1 | 0 | 33.3% |
| terminal | 14 | 7 | 7 | 0 | 0 | 0 | 100.0% |
| rail | 9 | 10 | 8 | 2 | 0 | 0 | 90.0% |
| git | 9 | 9 | 8 | 1 | 0 | 0 | 94.4% |
| explorer | 7 | 4 | 4 | 0 | 0 | 0 | 100.0% |
| editor | 7 | 4 | 3 | 1 | 0 | 0 | 87.5% |
| side-panel | 5 | 5 | 5 | 0 | 0 | 0 | 100.0% |
| settings | 4 | 14 | 4 | 9 | 0 | 1 | 60.7% |
| statusbar | 3 | 3 | 3 | 0 | 0 | 0 | 100.0% |
| palette | 3 | 11 | 11 | 0 | 0 | 0 | 100.0% |
| theme | 2 | 21 | 21 | 0 | 0 | 0 | 100.0% |
| shortcuts | 1 | 7 | 5 | 1 | 0 | 1 | 78.6% |
| dialogs | 1 | 1 | 1 | 0 | 0 | 0 | 100.0% |
| browser | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| notifications | 1 | 2 | 1 | 0 | 0 | 1 | 50.0% |
| remote | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| snapshots | 0.5 | 2 | 1 | 0 | 0 | 1 | 50.0% |
| canvas | 0.5 | 1 | 1 | 0 | 0 | 0 | 100.0% |
| ssh | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |

### Ranked gaps

Rank is the reviewed impact (1 to 3) times the area weight.

| # | Surface | Status | Root cause class | Proposed unit | Rank | What differs |
| ---: | --- | --- | --- | --- | ---: | --- |
| 1 | `chat.send` | partial | missing GPUIX capability | mermaid diagrams (unassigned) | 34 | Typing and Enter start a chat and the scripted reply streams in both. Mermaid shows as source ("Mermaid diagrams are shown as source in this client") where the web draws the diagram. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Two prose differences remain: task-list items draw ☑ and ☐ text glyphs where the web draws checkbox boxes, and a paragraph holding inline code wraps about 60 px wider than the web column, so its lines break at different words. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| 2 | `chat.queue` | broken | needs diagnosis | chat started from the launcher renders late (unassigned) | 34 | A prompt sent while the turn runs shows under 1 Queued with the stop button in place of send in GPUIX as on the web, but the GPUIX transcript differs in 3 of 3 runs. In the full run and the second rerun it stays empty: no matrix hold bubble and no Working row with "Holding this turn open for the queue." In the first rerun the follow-up was sent as a new turn instead of queued (the type action timed out waiting for the GPUI key command) and the first turn showed as finished. In the full run the composer chip also read "Agent" instead of Chat Scenario Agent, and the Chats list shows a second matrix hold card marked New. |
| 3 | `composer.attach` | broken | native override needed | attach file dialog (unassigned) | 28 | Clicking Attach files shows a red "Failed to open file picker" toast in GPUIX, in 2 of 2 runs. Outside Tauri the composer takes the browser path (`pickAttachmentFilesBrowser` in use-composer-attachments.ts), which needs a DOM file input that GPUIX cannot open. The web opens the native file chooser, which Playwright does not paint, so its frame shows nothing. GPUIX has a native path dialog (`promptForPaths`), so an override of the picker that uses it would close this. |
| 4 | `chat.transcript` | partial | native override needed | O5 prose remainder: task boxes, wrap width, tables | 17 | The transcript, code card, task list, Worked for row and Changed files bar all render. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Two prose differences remain: task-list items draw ☑ and ☐ text glyphs where the web draws checkbox boxes, and a paragraph holding inline code wraps about 60 px wider than the web column, so its lines break at different words. The text check fails only because natively painted text is not in the automation tree. |
| 5 | `chat.scroll-top` | partial | native override needed | O5 prose remainder: task boxes, wrap width, tables | 17 | One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button. The table card has copy and download buttons but not the web's expand button, its columns split the width differently (Panes mounted is wider), and each row is about 2 px taller. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Two prose differences remain: task-list items draw ☑ and ☐ text glyphs where the web draws checkbox boxes, and a paragraph holding inline code wraps about 60 px wider than the web column, so its lines break at different words. The text check fails only because natively painted text is not in the automation tree. |
| 6 | `chat.agent-launcher` | partial | compat translator gap | C2 menus and popovers | 17 | The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. In GPUIX the agent chip is narrower and truncates to "Chat Scen…", with the more button beside it. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| 7 | `chat.model-selector` | partial | native override needed | O5 prose remainder: task boxes, wrap width, tables | 17 | The running chat shows the agent chip and composer like the web. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Two prose differences remain: task-list items draw ☑ and ☐ text glyphs where the web draws checkbox boxes, and a paragraph holding inline code wraps about 60 px wider than the web column, so its lines break at different words. |
| 8 | `chat.plan` | partial | compat translator gap | plan card ring and rotate (unassigned) | 17 | The pinned Plan panel and the inline plan card show the same three entries, Medium chips, the struck-through finished entry and the 1/3 count, and the short transcript starts at the top in both. The card frames differ. The web card is `bg-card/30` with a `ring-1 ring-border/50` hairline and a divider under its header; GPUIX fills it lighter, with no ring and no divider, and its collapse chevron points down because GPUIX draws no `rotate-180`. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| 9 | `composer.mention` | partial | native override needed | composer focus listeners (G7) | 14 | Both show "No files or folders match" for a bare @ on this server, so the file list itself is not compared here (tools/composer/e2e.ts covers it). The web composer shows its focus border and inset ring while it holds the caret; GPUIX shows the resting border. The composer's native textarea and its key-capture div (src/overrides ChatComposerEditor) have no onFocus/onBlur, so GPUIX emits no focus event for the wrapper's `focus-within:`. A G6 probe that gave both an empty onFocus and onBlur drew the border and ring as on the web (top edge 35 and 57 against 36 and 58). |
| 10 | `composer.slash` | partial | native override needed | composer focus listeners (G7) | 14 | The Skills menu matches row for row. The web composer shows its focus border and inset ring while it holds the caret; GPUIX shows the resting border. The composer's native textarea and its key-capture div (src/overrides ChatComposerEditor) have no onFocus/onBlur, so GPUIX emits no focus event for the wrapper's `focus-within:`. A G6 probe that gave both an empty onFocus and onBlur drew the border and ring as on the web (top edge 35 and 57 against 36 and 58). |
| 11 | `rail.project-remove` | partial | compat translator gap | confirm dialog stacking (unassigned) | 9 | Delete from the context menu asks for confirmation and removes delta in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). The web paints the workspace status bar sharp above the confirm scrim: ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling, so DOM order puts the bar on top. GPUIX puts the fixed overlay above everything, so the bar is dimmed and blurred with the rest. |
| 12 | `rail.add-menu` | partial | compat translator gap | title tooltips (unassigned) | 9 | Clicking + opens the New project / New folder group menu and New project opens the Create New Project modal with the same fields in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). GPUIX paints the + button's "Add project or folder group" title tooltip above the modal and its scrim; the web shows none. The footnote wraps "memory-only" at a different word. |
| 13 | `git.discard` | partial | compat translator gap | confirm dialog stacking (unassigned) | 9 | The confirm dialog matches. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). The web paints the workspace status bar sharp above the confirm scrim: ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling, so DOM order puts the bar on top. GPUIX puts the fixed overlay above everything, so the bar is dimmed and blurred with the rest. |
| 14 | `settings.ai-agents` | partial | needs diagnosis | agent registry list in settings (unassigned) | 8 | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The agents list shows No agents match "" while the web lists the registry (Agoragentic first). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). The scrim dims and blurs the page behind it as on the web (N2). |
| 15 | `editor.markdown` | partial | native override needed | E2 markdown preview parity | 7 | Preview has the "On this page" outline (G4) and the heading and paragraph rows land on the web rows; heading sizes follow BlockNote (48/32 px). The heading has no -0.018em letter spacing (GPUIX has none), so "Alpha guide" is about 10 px wider, and the list bullets are larger and brighter, with the items set further right. The tab reads "guide.md" in full at the web width (C15 fixed in G5). A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. |
| 16 | `settings.notifications` | partial | compat translator gap | inline label line height in settings rows (unassigned) | 4 | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). |
| 17 | `settings.editor` | partial | compat translator gap | inline label line height in settings rows (unassigned) | 4 | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). |
| 18 | `settings.appearance` | partial | compat translator gap | inline label line height in settings rows (unassigned) | 4 | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). |
| 19 | `settings.skills` | partial | compat translator gap | inline label line height in settings rows (unassigned) | 4 | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). |
| 20 | `settings.provider` | partial | compat translator gap | account row wide layout (unassigned) | 4 | Accounts lists the Default account, Signed in, with "Usage is not available right now", Try again and the `termul-server claude account` hint in both. The skeleton M2 saw was the frame grab racing the list: the step checked for the nav label it had just clicked. It now waits for "1 account", which GPUIX painted 1871 ms after the click and the web 158 ms after (G6 run). GPUIX puts the usage note under the account name, where the web sets it beside the name in the wide layout. The scrim dims and blurs the page behind it as on the web (N2). |
| 21 | `settings.mcp-servers` | partial | compat translator gap | inline code wrap in settings text (unassigned) | 4 | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). The inline code in the footnote breaks onto its own line. |
| 22 | `settings.shortcuts` | partial | compat translator gap | inline label line height in settings rows (unassigned) | 4 | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). GPUIX lists the desktop keymap (Ctrl+R, Ctrl+T, Ctrl+,) where the web lists its defaults (Press keys…, Alt+T, Alt+,), by design since G4. |
| 23 | `settings.diagnostics` | partial | compat translator gap | inline label line height in settings rows (unassigned) | 4 | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). Server version reads termul-server v0.4.52 in both: GPUIX asks the server (G4). |
| 24 | `shortcuts.zoom-in` | partial | needs diagnosis | web zoom overflow (unassigned) | 1 | Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4's keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both). The zoomed web page runs past the window bottom, so its status bar is cut off and the dashboard heading sits 25 px lower; GPUIX keeps the status bar in the window. |
| 25 | `update.toast` | blocked | native override needed | U1 GPUIX updater and what's new | 1 | Not compared: the update toast and the what's new modal render only under isTauriContext(), so neither client shows them (the web hides them by design). The packaged GPUIX app has a command-line check, `termul-gpuix --check-update`, against the release feed, but no in-app toast. |
| 26 | `remote.access-popover` | blocked | server route needed | R4 desktop host role over the server | 0.5 | Not compared: the popover renders only under isTauriContext(), so the web client has no reference. |

### Proposed units

Each unit with the surfaces its gaps name. Gain is the usage-weighted score (all surfaces) the matrix would report if every one of those surfaces became ported, everything else unchanged.

| # | Unit | Root cause class | Surfaces | Summed rank | Gain |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | O5 prose remainder: task boxes, wrap width, tables | native override needed | 3 | 51 | +2.8 |
| 2 | mermaid diagrams (unassigned) | missing GPUIX capability | 1 | 34 | +0.9 |
| 3 | chat started from the launcher renders late (unassigned) | needs diagnosis | 1 | 34 | +1.9 |
| 4 | attach file dialog (unassigned) | native override needed | 1 | 28 | +4.7 |
| 5 | composer focus listeners (G7) | native override needed | 2 | 28 | +4.7 |
| 6 | inline label line height in settings rows (unassigned) | compat translator gap | 6 | 24 | +0.9 |
| 7 | confirm dialog stacking (unassigned) | compat translator gap | 2 | 18 | +0.9 |
| 8 | C2 menus and popovers | compat translator gap | 1 | 17 | +0.9 |
| 9 | plan card ring and rotate (unassigned) | compat translator gap | 1 | 17 | +0.9 |
| 10 | title tooltips (unassigned) | compat translator gap | 1 | 9 | +0.4 |
| 11 | agent registry list in settings (unassigned) | needs diagnosis | 1 | 8 | +0.1 |
| 12 | E2 markdown preview parity | native override needed | 1 | 7 | +0.9 |
| 13 | account row wide layout (unassigned) | compat translator gap | 1 | 4 | +0.1 |
| 14 | inline code wrap in settings text (unassigned) | compat translator gap | 1 | 4 | +0.1 |
| 15 | web zoom overflow (unassigned) | needs diagnosis | 1 | 1 | +0.1 |
| 16 | U1 GPUIX updater and what's new | native override needed | 1 | 1 | +0.5 |
| 17 | R4 desktop host role over the server | server route needed | 1 | 0.5 | +0.5 |

If every listed unit landed and fixed its surfaces, the usage-weighted score would be 97.8%.

### Surfaces

Web and GPUIX columns count passed actions plus checks over the total. Mismatch is exact / perceptual for the last step: the full 1280x800 frame, and the region the surface names (measured in the web client, cropped from both frames).

| Surface | Area | Status | Auto | Web | GPUIX | Full mismatch | Region mismatch | Differences seen |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `rail.project-list` Project list and switching | rail | ported | ported | 10/10 | 10/10 | 5.7% / 0.95% | 3.2% / 0.59% | Same layout and order; switching to beta works by click in both (H1 fixed the lost clicks: `bun tools/clickloss/run.ts --trials 20` switched projects 60/60 through automation and XTEST). After the switch the beta composer shows Chat Scenario Agent in both. GPUIX gets there later: the agent chip appeared 967 ms (rail) and 586 ms (palette) after the switch in GPUIX and within 82 ms on the web (G6 run; the step now waits for it, so the frames match). The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `rail.project-menu` Project context menu | rail | ported | ported | 3/3 | 3/3 | 7.1% / 1.19% | 7.5% / 1.75% | Right-click opens the project menu with the same rows, icons, submenu chevrons and red Delete, at the same place (G3: Radix opens a context menu 2 px right of the pointer). Row labels sit where the web puts them (G5: the " Label" text in a row's nested {icon}{children}{after} array is trimmed like any flex text run; it had kept its leading space, 3 px). Under the open menu GPUIX keeps the hovered beta row's gear and shortcut; the web hides them, since a modal Radix menu turns pointer events off on the page. |
| `rail.project-rename` Rename a project | rail | ported | ported | 8/8 | 8/8 | 6.2% / 1.09% | 3.5% / 0.69% | Rename from the context menu edits the row in place and Enter saves gamma-renamed in both. |
| `rail.project-remove` Remove a project | rail | partial | ported | 6/6 | 6/6 | 6.1% / 1.08% |  | Delete from the context menu asks for confirmation and removes delta in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). The web paints the workspace status bar sharp above the confirm scrim: ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling, so DOM order puts the bar on top. GPUIX puts the fixed overlay above everything, so the bar is dimmed and blurred with the rest. |
| `rail.project-colour` Project colour picker | rail | ported | ported | 4/4 | 4/4 | 6.9% / 1.07% |  | Change Color opens the Select Color popover with the same nine swatches and the current one ringed. |
| `rail.project-reorder` Reorder projects by drag | rail | ported | ported | 4/4 | 4/4 | 6.2% / 1.08% | 3.6% / 0.64% | Dragging gamma onto alpha reorders the list to alpha, gamma, beta in both (C3 fixed in G3: the framer-motion shim drives Reorder from pointer moves with framer's one-neighbour-per-move rule). The dragged row does not follow the pointer in GPUIX, which has no transforms; the list reorders live under it. After the drop both clients stay on alpha and paint alpha and gamma in their hover state (gear and Ctrl+1/Ctrl+2), with the action strip's fade over alpha's +4 -1 diff stat. |
| `rail.add-menu` Add project menu and new project modal | rail | partial | ported | 5/5 | 5/5 | 79.1% / 0.49% |  | Clicking + opens the New project / New folder group menu and New project opens the Create New Project modal with the same fields in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). GPUIX paints the + button's "Add project or folder group" title tooltip above the modal and its scrim; the web shows none. The footnote wraps "memory-only" at a different word. |
| `rail.collapse` Collapse and expand the rail | rail | ported | ported | 3/3 | 3/3 | 6.3% / 0.94% |  | The collapsed rail matches: icons, project letters, Changes badge, and the Open canvas pencil under Search (G6: the action column is `flex-1` above an `mt-auto` footer, and the footer's auto-margin wrapper grew too and took half the free space, so the column clipped the pencil; a column now holds the wrapper back beside a growing sibling, as a row did). The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `rail.project-settings` Project settings modal | rail | ported | ported | 5/5 | 5/5 | 31.1% / 0.49% |  | Clicking the gear opens Project settings with General and the same fields in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). H1 fixed the lost gear click: compat keeps an element hovered while a blocking box inside it is hovered (`src/compat/hover.ts`); `bun tools/clickloss/run.ts --trials 20` opened the modal 60/60 through automation and XTEST. |
| `side.chats` Chats tab with a chat card | side-panel | ported | ported | 2/2 | 2/2 | 6.1% / 1.07% | 1.5% / 0.63% | The card title, agent, branch and age match; with more chats the cards stack one per row (G2 native ChatsList). |
| `side.chats-search` Search chats | side-panel | ported | ported | 7/7 | 7/7 | 6.1% / 1.07% |  | Filtering to no match and back matches, including the No matches. text. |
| `side.chat-card-menu` Chat card context menu | side-panel | ported | ported | 5/5 | 5/5 | 7.3% / 1.21% |  | Right-click on a chat card opens the same five-row menu with Delete Chat in red. |
| `side.workspace-switcher` Workspace (worktree) switcher | side-panel | ported | ported | 3/3 | 3/3 | 7.5% / 1.05% |  | The Working copies popover matches; GPUIX omits the small terminal glyph on the web row hover. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| `side.hide` Hide and show the side panel | side-panel | ported | ported | 3/3 | 3/3 | 5.7% / 0.85% |  | Side panel hides; the expand chevron sits in the same place. |
| `explorer.tree` File tree | explorer | ported | ported | 6/6 | 6/6 | 6.2% / 1.04% |  | Tree, git colours and status letters match. |
| `explorer.expand` Expand a folder | explorer | ported | ported | 6/6 | 6/6 | 6.4% / 1.06% |  | Clicking src expands it to app.ts and utils.ts in both, with no tooltip over the row. The web frame also catches the row name hint that FileTreeNode shows after 900 ms of hover; the GPUIX frame is grabbed before it fires. |
| `explorer.context-menu` File context menu | explorer | ported | ported | 6/6 | 6/6 | 6.9% / 1.20% |  | Right-click on README.md opens the same file menu with Delete in red. |
| `explorer.drag` Drag a file from the tree into the pane to open it | explorer | ported | broken | 7/7 | 6/7 | 4.3% / 0.48% |  | Dragging notes.txt from the tree into the pane opens it in an editor tab in both (D1 compat drag and drop). |
| `editor.code` Code editor (CodeMirror) on a TypeScript file | editor | ported | broken | 6/6 | 5/6 | 4.2% / 0.76% |  | The native editor (E1) paints the same highlighted text, line numbers and active line; the text checks fail only because native text is painted inside GPUI and is not in the automation tree. |
| `editor.code-edit` Type into the code editor | editor | ported | broken | 9/9 | 7/9 | 4.1% / 0.74% |  | Click, End and typing put "// edited" on line 5 in both; the dirty dot shows on the tab. Same tree-text caveat as editor.code. |
| `editor.markdown` Markdown (BlockNote) editor | editor | partial | ported | 7/7 | 7/7 | 4.3% / 1.48% |  | Preview has the "On this page" outline (G4) and the heading and paragraph rows land on the web rows; heading sizes follow BlockNote (48/32 px). The heading has no -0.018em letter spacing (GPUIX has none), so "Alpha guide" is about 10 px wider, and the list bullets are larger and brighter, with the items set further right. The tab reads "guide.md" in full at the web width (C15 fixed in G5). A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. |
| `editor.tabs` Two editor tabs and switching | editor | ported | broken | 8/8 | crash |  |  | Switching tabs works; the README preview matches the web, outline included. The tabs read README.md and app.ts in full at the web widths (C15 fixed in G5). The text check fails only because natively painted text is not in the automation tree. |
| `git.changes` Changes panel: staged, unstaged, untracked | git | ported | ported | 5/5 | 5/5 | 9.5% / 1.32% |  | Sections, rows, counts and history footer match, and the Amend last commit checkbox draws as the Chromium box (C5, G3). The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.amend` Amend last commit: the label and the box toggle it | git | ported | ported | 9/9 | 9/9 | 9.5% / 1.31% |  | Clicking the Amend last commit label checks the box and the button reads Amend commit with the last message filled in; clicking the box clears it, in both. The box, its check and its colours are sampled from Chromium. The web frames show the box in its hover colour because the pointer rests on it; GPUIX automation clicks without moving the pointer. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.diff` Diff view of an unstaged file | git | ported | ported | 5/5 | 5/5 | 57.9% / 1.33% |  | Inline diff, hunk header and STAGE HUNK match closely. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.stage` Stage a file | git | ported | ported | 5/5 | 5/5 | 59.0% / 1.67% |  | Staging README.md moves it to Staged 2 in both. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.unstage` Unstage a file | git | ported | ported | 5/5 | 5/5 | 10.0% / 1.29% |  | Unstaging app.ts moves it to Changes in both. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.discard` Discard a change (confirm dialog) | git | partial | ported | 5/5 | 5/5 | 90.4% / 0.40% |  | The confirm dialog matches. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). The web paints the workspace status bar sharp above the confirm scrim: ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling, so DOM order puts the bar on top. GPUIX puts the fixed overlay above everything, so the bar is dimmed and blurred with the rest. |
| `git.commit` Commit staged changes | git | ported | ported | 7/7 | 7/7 | 14.4% / 1.48% |  | The commit lands (4 commits, bump version) in both. The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual. |
| `git.branch-picker` Branch picker | git | ported | ported | 3/3 | 3/3 | 8.2% / 1.29% |  | Branch popover, Local group, feature/login and Create branch row match. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| `git.worktree-create` Working copies switcher: search or create a worktree | git | ported | ported | 5/5 | 5/5 | 7.5% / 0.99% |  | Typing a new name shows No matching working copies and Create worktree feat-matrix in both. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| `chat.transcript` Open a chat: transcript, tool cards, changed files | chat | partial | broken | 5/5 | 4/5 | 15.8% / 2.07% | 19.3% / 3.52% | The transcript, code card, task list, Worked for row and Changed files bar all render. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Two prose differences remain: task-list items draw ☑ and ☐ text glyphs where the web draws checkbox boxes, and a paragraph holding inline code wraps about 60 px wider than the web column, so its lines break at different words. The text check fails only because natively painted text is not in the automation tree. |
| `chat.scroll-top` Transcript scrolled to the first turn | chat | partial | broken | 7/7 | 5/7 | 18.7% / 3.08% | 26.3% / 5.95% | One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button. The table card has copy and download buttons but not the web's expand button, its columns split the width differently (Panes mounted is wider), and each row is about 2 px taller. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Two prose differences remain: task-list items draw ☑ and ☐ text glyphs where the web draws checkbox boxes, and a paragraph holding inline code wraps about 60 px wider than the web column, so its lines break at different words. The text check fails only because natively painted text is not in the automation tree. |
| `chat.new-chat` New chat button | chat | ported | ported | 3/3 | 3/3 | 47.2% / 0.99% |  | New chat opens the launcher composer in place. |
| `chat.agent-launcher` Agent launcher menu | chat | partial | ported | 3/3 | 3/3 | 7.3% / 1.21% |  | The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. In GPUIX the agent chip is narrower and truncates to "Chat Scen…", with the more button beside it. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| `chat.send` Send a prompt from the dashboard and stream the reply | chat | partial | broken | 7/7 | 6/7 | 24.2% / 3.02% |  | Typing and Enter start a chat and the scripted reply streams in both. Mermaid shows as source ("Mermaid diagrams are shown as source in this client") where the web draws the diagram. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Two prose differences remain: task-list items draw ☑ and ☐ text glyphs where the web draws checkbox boxes, and a paragraph holding inline code wraps about 60 px wider than the web column, so its lines break at different words. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.model-selector` Model and mode selector in a running chat | chat | partial | partial | 4/4 | 4/4 | 16.2% / 2.21% |  | The running chat shows the agent chip and composer like the web. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Two prose differences remain: task-list items draw ☑ and ☐ text glyphs where the web draws checkbox boxes, and a paragraph holding inline code wraps about 60 px wider than the web column, so its lines break at different words. |
| `chat.plan` Plan panel from a plan update | chat | partial | broken | 10/10 | 9/10 | 26.5% / 1.98% |  | The pinned Plan panel and the inline plan card show the same three entries, Medium chips, the struck-through finished entry and the 1/3 count, and the short transcript starts at the top in both. The card frames differ. The web card is `bg-card/30` with a `ring-1 ring-border/50` hairline and a divider under its header; GPUIX fills it lighter, with no ring and no divider, and its collapse chevron points down because GPUIX draws no `rotate-180`. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.permission` Permission prompt: allow a tool call | chat | ported | broken | 12/12 | 11/12 | 9.6% / 1.18% |  | The Approval needed card, its Allow and Reject buttons, the Needs you badge and the status-bar pill match; clicking Allow answers allow-once in both. The short transcript starts at the top in both. The tab title reads in full at the web width (C15 fixed in G5). The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.queue` Prompt queue while a turn runs | chat | broken | broken | 12/12 | 11/12 | 19.6% / 1.59% |  | A prompt sent while the turn runs shows under 1 Queued with the stop button in place of send in GPUIX as on the web, but the GPUIX transcript differs in 3 of 3 runs. In the full run and the second rerun it stays empty: no matrix hold bubble and no Working row with "Holding this turn open for the queue." In the first rerun the follow-up was sent as a new turn instead of queued (the type action timed out waiting for the GPUI key command) and the first turn showed as finished. In the full run the composer chip also read "Agent" instead of Chat Scenario Agent, and the Chats list shows a second matrix hold card marked New. |
| `composer.mention` Mention menu (@) | composer | partial | ported | 4/4 | 4/4 | 8.2% / 1.89% |  | Both show "No files or folders match" for a bare @ on this server, so the file list itself is not compared here (tools/composer/e2e.ts covers it). The web composer shows its focus border and inset ring while it holds the caret; GPUIX shows the resting border. The composer's native textarea and its key-capture div (src/overrides ChatComposerEditor) have no onFocus/onBlur, so GPUIX emits no focus event for the wrapper's `focus-within:`. A G6 probe that gave both an empty onFocus and onBlur drew the border and ring as on the web (top edge 35 and 57 against 36 and 58). |
| `composer.slash` Slash command menu (/) | composer | partial | ported | 4/4 | 4/4 | 10.9% / 1.94% |  | The Skills menu matches row for row. The web composer shows its focus border and inset ring while it holds the caret; GPUIX shows the resting border. The composer's native textarea and its key-capture div (src/overrides ChatComposerEditor) have no onFocus/onBlur, so GPUIX emits no focus event for the wrapper's `focus-within:`. A G6 probe that gave both an empty onFocus and onBlur drew the border and ring as on the web (top edge 35 and 57 against 36 and 58). |
| `composer.attach` Attach files button | composer | broken | ported | 2/2 | 2/2 | 7.7% / 1.76% |  | Clicking Attach files shows a red "Failed to open file picker" toast in GPUIX, in 2 of 2 runs. Outside Tauri the composer takes the browser path (`pickAttachmentFilesBrowser` in use-composer-attachments.ts), which needs a DOM file input that GPUIX cannot open. The web opens the native file chooser, which Playwright does not paint, so its frame shows nothing. GPUIX has a native path dialog (`promptForPaths`), so an override of the picker that uses it would close this. |
| `terminal.open` Open a terminal from the status bar | terminal | ported | ported | 4/4 | 4/4 | 3.8% / 1.09% |  | Terminal tab, its full "Terminal 1" title at the web width, and the prompt match (C15 fixed in G5). The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. Flake: in the full run the GPUIX frame was grabbed before the prompt painted, with the status-bar title tooltip up; the rerun matched. |
| `terminal.type` Type a command and see its output | terminal | ported | ported | 5/5 | 5/5 | 4.2% / 1.26% |  | echo output matches cell for cell. |
| `terminal.vim-replies` Terminal query replies after vim (T1 fixture shape) | terminal | ported | ported | 8/8 | 8/8 | 4.2% / 1.26% |  | With the O1 fixture's command (vim -u NONE -N notes.txt, then :q!) typed into the full app, both clients return to a clean prompt; neither echoes ^[[>0;276;0c or rgb: replies. So the echo in O1's GPUIX shot does not reproduce in the full app with typed input: it belongs to the fixture, which writes its inputs to the PTY back to back, not to GPUIX (inferred; the fixture itself was not rerun here). |
| `terminal.file-link` Ctrl+click a file path in terminal output opens it in the editor | terminal | ported | broken | 8/8 | 7/8 | 5.2% / 1.25% |  | Ctrl+click on src/app.ts in terminal output opens app.ts in a new tab in both. The text check fails only because natively painted text is not in the automation tree. |
| `terminal.new-tab-menu` New tab menu (terminal, browser, ...) | terminal | ported | ported | 3/3 | 3/3 | 9.0% / 1.69% |  | The new tab menu matches. |
| `terminal.tab-reorder` Reorder terminal tabs by dragging | terminal | ported | ported | 10/10 | 10/10 | 4.0% / 1.09% |  | Dropping Terminal 2 on the left edge of Terminal 1 moves it first in both, and both clients read Terminal 2, Terminal 1 with full titles at the web widths (C15 fixed in G5). Flake: the full run failed at the terminal limit (harness leak, fixed); in the first rerun the GPUIX click on Bash in the just-opened New tab menu was lost, so only Terminal 1 opened; the second rerun matched. |
| `terminal.split` Split panes: drag a second terminal tab to the pane edge | terminal | ported | ported | 12/12 | 12/12 | 4.2% / 1.41% |  | Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1), and each pane's tab shows its full title with its close button (C15 fixed in G5). In the full run both clients failed here at the server's terminal limit (10 per project), a harness leak: preserved PTYs from earlier surfaces piled up. The matrix now closes them before each client run (`tools/matrix/terminals.ts`), and the rerun matched. |
| `statusbar.items` Status bar items | statusbar | ported | partial | 2/2 | 2/2 | 7.6% / 1.60% | 12.3% / 4.62% | Branch, path, Terminal and settings items line up. The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. The rest of the region diff is glyph antialiasing: Chromium draws the status bar text with subpixel (LCD) colour fringes, and GPUIX draws it in grayscale (C8). |
| `statusbar.context-bar` Context bar settings popover | statusbar | ported | ported | 3/3 | 3/3 | 8.6% / 1.78% |  | The Show in Context Bar popover opens with the same five toggles and states. |
| `statusbar.connection` Connection indicator hover | statusbar | ported | ported | 3/3 | 3/3 | 8.1% / 1.66% |  | Hovering the connection lamp shows the Connected tooltip in both. The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `remote.access-popover` Remote access popover (desktop shared-live host) | remote | blocked | blocked | n/a | n/a |  |  | Not compared: the popover renders only under isTauriContext(), so the web client has no reference. |
| `settings.interface` Settings: Interface | settings | ported | ported | 5/5 | 5/5 | 32.2% / 0.97% | 4.2% / 1.43% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.notifications` Settings: Notifications | settings | partial | ported | 5/5 | 5/5 | 34.3% / 1.26% | 7.3% / 1.86% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). |
| `settings.editor` Settings: Editor | settings | partial | ported | 5/5 | 5/5 | 32.6% / 0.80% | 4.8% / 1.18% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). |
| `settings.appearance` Settings: Appearance | settings | partial | partial | 5/5 | 5/5 | 39.3% / 2.17% | 14.5% / 3.19% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). |
| `settings.shell` Settings: Shell | settings | ported | ported | 5/5 | 5/5 | 31.5% / 0.59% | 3.1% / 0.87% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.terminal-profiles` Settings: Profiles | settings | ported | ported | 5/5 | 5/5 | 31.5% / 0.57% | 3.1% / 0.83% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.ai-agents` Settings: Agent chats | settings | partial | partial | 5/5 | 5/5 | 36.2% / 2.29% | 10.0% / 3.37% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The agents list shows No agents match "" while the web lists the registry (Agoragentic first). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.skills` Settings: Skills | settings | partial | partial | 5/5 | 5/5 | 35.4% / 1.78% | 8.8% / 2.62% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). |
| `settings.provider` Settings: Accounts | settings | partial | ported | 5/5 | 5/5 | 32.7% / 0.71% | 4.9% / 1.05% | Accounts lists the Default account, Signed in, with "Usage is not available right now", Try again and the `termul-server claude account` hint in both. The skeleton M2 saw was the frame grab racing the list: the step checked for the nav label it had just clicked. It now waits for "1 account", which GPUIX painted 1871 ms after the click and the web 158 ms after (G6 run). GPUIX puts the usage note under the account name, where the web sets it beside the name in the wide layout. The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.mcp-servers` Settings: MCP servers | settings | partial | partial | 5/5 | 5/5 | 35.6% / 1.37% | 9.2% / 2.01% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). The inline code in the footnote breaks onto its own line. |
| `settings.shortcuts` Settings: Keyboard shortcuts | settings | partial | partial | 5/5 | 5/5 | 34.4% / 1.40% | 7.4% / 2.06% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). GPUIX lists the desktop keymap (Ctrl+R, Ctrl+T, Ctrl+,) where the web lists its defaults (Press keys…, Alt+T, Alt+,), by design since G4. |
| `settings.diagnostics` Settings: Logs | settings | partial | ported | 5/5 | 5/5 | 35.5% / 1.30% | 9.0% / 1.91% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each row is about 4 px shorter in GPUIX: the label is an inline `<label>` whose CSS line box takes the 24 px strut of its block parent, and GPUIX lays it out at its own 20 px line height (inferred from the row heights). Server version reads termul-server v0.4.52 in both: GPUIX asks the server (G4). |
| `settings.reset` Settings: Reset | settings | ported | ported | 5/5 | 5/5 | 31.5% / 0.73% | 3.1% / 1.07% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). |
| `palette.open` Command palette (Ctrl+K) and filtering | palette | ported | ported | 9/9 | 9/9 | 7.6% / 1.60% |  |  |
| `palette.type-ahead` Typing straight after Ctrl+K reaches the palette filter | palette | ported | ported | 5/5 | 5/5 | 74.2% / 0.50% |  | Typing "theme" straight after Ctrl+K filters the palette in both, and the rows rank the same (C16 fixed in G3: the cmdk shim scores with cmdk's command-score and sorts as cmdk does), Open Canvas first under Workspace. GPUIX is deterministic (G5): keys typed after the palette input took focus but before it first painted focused, which GPUI drops for want of a text input handler, are held and given to the field on its focus event. It passed 7 of 7 G5 runs, where it had failed 3 of 5 with the window active (an empty filter). The web still races: CommandPalette blurs the active element and focuses its input in a setTimeout(0), so keys that beat that timeout are dropped ("eme" in 2 of 12 G5 runs). That is a real web bug a fast typist can hit, not a harness artifact. The search field shows its focus underline as on the web (G5: the matrix makes the GPUIX window the active X window, as the Playwright page is focused; an inactive GPUI window gets no focus events). |
| `palette.new-terminal` Palette command: New Terminal | palette | ported | ported | 8/8 | 8/8 | 3.7% / 1.10% |  | New Terminal opens Terminal 1 in both. In the full run both clients hit the server's terminal limit (a harness leak, fixed by `tools/matrix/terminals.ts`); the rerun matched. That frame also showed the GPUIX error toast too narrow for its message: the text runs past the window edge, where the web toast wraps to two lines. |
| `palette.agent-launcher` Palette command: Agent Launcher | palette | ported | ported | 9/9 | 9/9 | 48.6% / 1.52% |  | Agent Launcher shows the launcher with its close button in both. |
| `palette.save-snapshot` Palette command: Save Workspace Snapshot | snapshots | ported | ported | 9/9 | 9/9 | 83.2% / 0.17% |  | The Create Snapshot modal matches. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.open-canvas` Palette command: Open Canvas | palette | ported | ported | 10/10 | 10/10 | 4.0% / 1.07% |  | Open Canvas opens design.figcraft in both, and the FigCraft editor reaches Ready in GPUIX through the browser-pane webview (V1) with the pinned bundle (run with `tools/canvas/server-with-bundle.ts`). The editor is dark in both, page colour 1E1E1E (G6: the webview helper starts on the dark GTK theme while Termul is dark, so WebKitGTK reports prefers-color-scheme dark before host.theme arrives). |
| `palette.project-settings` Palette command: Project Settings | palette | ported | ported | 9/9 | 9/9 | 31.1% / 0.49% |  | Project settings opens on General with the same fields. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.app-preferences` Palette command: App Preferences | palette | ported | ported | 9/9 | 9/9 | 32.2% / 0.97% |  | Preferences opens on Interface in both, laid out wide. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). Flake, 2 of 3 runs differ: in the full run the GPUIX launch crashed with "Timed out after 2 seconds waiting for the automation bounds query" (C13), and in the first rerun GPUIX grabbed the Interface rows laid out narrow (zoom stepper and swatches under their descriptions), the container-query first frame before the card has measured itself. The second rerun matched. |
| `palette.switch-project` Palette command: beta | rail | ported | ported | 12/12 | 12/12 | 5.7% / 0.96% |  | Typing beta filters to the beta row and Enter switches to beta in both. After the switch the beta composer shows Chat Scenario Agent in both. GPUIX gets there later: the agent chip appeared 967 ms (rail) and 586 ms (palette) after the switch in GPUIX and within 82 ms on the web (G6 run; the step now waits for it, so the frames match). |
| `palette.command-history` Palette command: Command History | palette | ported | ported | 9/9 | 9/9 | 80.5% / 0.20% |  | The Command History modal, its scope picker and empty state match, and the search field shows its focus border in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.color-theme` Palette command: Change Color Theme | palette | ported | ported | 9/9 | 9/9 | 20.5% / 1.27% |  | Change Color Theme opens the Color Themes popover in both. The focused field shows its focus border as on the web (G6: native patch gpuix/0008 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). |
| `palette.shortcut-menu` Palette command: Open Shortcut Menu | palette | ported | ported | 9/9 | 9/9 | 77.8% / 0.49% |  | Opens the Shortcut Menu in both; GPUIX shows the desktop keymap chips (see shortcuts.menu). The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.report-bug` Palette command: Report a Bug | palette | ported | ported | 9/9 | 9/9 | 59.5% / 0.83% |  | Opens the Report a bug dialog, laid out as in dialogs.bug-report. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). The focused field shows its focus border as on the web (G6: native patch gpuix/0008 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). |
| `shortcuts.menu` Keyboard shortcuts popover | shortcuts | ported | ported | 3/3 | 3/3 | 76.0% / 0.49% |  | Shortcut Menu rows, descriptions and key chips line up. GPUIX shows the desktop keymap chips (Ctrl+R, Ctrl+,, Ctrl+=) where the web shows its Alt defaults and a blank Command History chip (G4, by design). The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `shortcuts.settings-shortcut` Settings shortcut (web Alt+,, desktop Ctrl+,); Escape closes the dialog | shortcuts | ported | ported | 6/6 | 6/6 | 7.6% / 1.61% |  | Each client presses its own key (G3): Alt+, on the web and the desktop Ctrl+, in GPUIX (G4 keymap) open Preferences, and Escape closes it in both. |
| `shortcuts.toggle-projects` Default shortcut ctrl-shift-b: collapse the project rail | shortcuts | ported | ported | 5/5 | 5/5 | 7.9% / 1.47% |  | Ctrl+Shift+B collapses the rail in both, with the Open canvas pencil under Search (see rail.collapse). |
| `shortcuts.toggle-side-panel` Default shortcut ctrl-b: hide the side panel | shortcuts | ported | ported | 5/5 | 5/5 | 5.7% / 0.85% |  | Ctrl+B hides the side panel in both. |
| `shortcuts.theme-picker` Default shortcut ctrl-alt-t: theme picker | shortcuts | ported | ported | 5/5 | 5/5 | 20.5% / 1.27% |  | Ctrl+Alt+T opens the Color Themes popover in both. The focused field shows its focus border as on the web (G6: native patch gpuix/0008 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). |
| `shortcuts.zoom-in` Default shortcut alt-=: zoom in | shortcuts | partial | partial | 5/5 | 5/5 | 17.6% / 3.69% |  | Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4's keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both). The zoomed web page runs past the window bottom, so its status bar is cut off and the dashboard heading sits 25 px lower; GPUIX keeps the status bar in the window. |
| `shortcuts.desktop-keymap` Desktop key bindings (Ctrl+T, Ctrl+W, Ctrl+R, Ctrl+, and Ctrl+=) | shortcuts | blocked | blocked | n/a | n/a |  |  | No web reference. GPUIX registers a desktop host, which now gets the same Ctrl-based keymap as Tauri (G4): workspace-checks asserts Ctrl+, opens Preferences, Ctrl+R opens command history and Alt+, does nothing. |
| `theme.picker` Theme picker | theme | ported | ported | 4/4 | 4/4 | 20.5% / 1.27% |  | The Color Themes popover, groups, swatches and the current-theme check match, and labels antialias in grayscale as on the web (C8 fixed in G3). The focused field shows its focus border as on the web (G6: native patch gpuix/0008 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). |
| `dialogs.bug-report` Report a bug dialog | dialogs | ported | ported | 3/3 | 3/3 | 59.5% / 0.83% |  | The Report a bug dialog paints its Title, What happened, Screenshots and Preview sections at the web width and wraps the same lines. The web draws a resize grip in the What happened corner; GPUIX has none. The focused field shows its focus border as on the web (G6: native patch gpuix/0008 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `canvas.open` Canvas | canvas | ported | ported | 4/4 | 4/4 | 4.5% / 1.06% |  | Clicking Canvas opens design.figcraft and the FigCraft editor reaches Ready in both: pages, layers, design panel, toolbar and Save (V1: the editor runs in a `termul-webview-host` webview placed over the pane; this run used the pinned bundle, sha256 verified against canvas/figcraft.pin). Panels and page are dark in both, page colour 1E1E1E (G6, see palette.open-canvas). |
| `browser.pane` Browser pane | browser | blocked | blocked | n/a | n/a |  |  | Not compared: the web client offers no browser tab, so there is no reference. GPUIX does have browser panes, a WebKitGTK webview in the `termul-webview-host` helper placed as an X11 child window (README, Browser panes), and `bun run package:verify` loads a local page in one from the .deb; neither was rerun here. |
| `notifications.toast` Toast after creating a branch | notifications | ported | ported | 7/7 | 7/7 | 8.3% / 1.67% |  | Typing the branch name and pressing Enter creates toast-branch and shows the success toast in both. The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual. After Enter the status-bar branch button holds focus and both draw a 1 px ring around "toast-branch" (G6: an outer ring paints as an outline; GPUI had painted the spread shadow under the whole transparent button, a light wash over the label). |
| `ssh.workspace` SSH profiles and sessions | ssh | blocked | blocked | n/a | n/a |  |  | No web reference: SSH needs a host-local client and a browser never is one, so the web client shows no SSH section. R2 drove the GPUIX real shell as a host-local client against a throwaway sshd (reports/r2-shots): the sidebar SSH section, the hosts tab, host-key trust, a connected shell and the SFTP file list all render. Not rerun here. |
| `settings.accounts-claude` Claude account sign-in | settings | blocked | blocked | n/a | n/a |  |  | No web reference: Claude account management needs a host-local client. The R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path; no GPUIX pixel check of the sign-in flow exists yet. |
| `update.toast` Update available toast and what's new modal | notifications | blocked | blocked | n/a | n/a |  |  | Not compared: the update toast and the what's new modal render only under isTauriContext(), so neither client shows them (the web hides them by design). The packaged GPUIX app has a command-line check, `termul-gpuix --check-update`, against the release feed, but no in-app toast. |
| `snapshots.page` Snapshots page (#/snapshots) | snapshots | blocked | blocked | n/a | n/a |  |  |  |
| `theme.termul-dark` Theme termul (dark) | theme | ported | ported | 2/2 | 2/2 | 7.7% / 1.63% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.termul-light` Theme termul (light) | theme | ported | ported | 2/2 | 2/2 | 5.5% / 1.68% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.cursor-dark` Theme cursor (dark) | theme | ported | ported | 2/2 | 2/2 | 5.0% / 1.50% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.cursor-light` Theme cursor (light) | theme | ported | ported | 2/2 | 2/2 | 5.5% / 1.66% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.catppuccin-dark` Theme catppuccin (dark) | theme | ported | ported | 2/2 | 2/2 | 7.6% / 1.48% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.catppuccin-light` Theme catppuccin (light) | theme | ported | ported | 2/2 | 2/2 | 5.9% / 1.51% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.dracula-dark` Theme dracula (dark) | theme | ported | ported | 2/2 | 2/2 | 5.4% / 1.53% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.dracula-light` Theme dracula (light) | theme | ported | ported | 2/2 | 2/2 | 5.9% / 1.60% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.nord-dark` Theme nord (dark) | theme | ported | ported | 2/2 | 2/2 | 5.4% / 1.53% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.nord-light` Theme nord (light) | theme | ported | ported | 2/2 | 2/2 | 5.9% / 1.56% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.gruvbox-dark` Theme gruvbox (dark) | theme | ported | ported | 2/2 | 2/2 | 7.6% / 1.49% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.gruvbox-light` Theme gruvbox (light) | theme | ported | ported | 2/2 | 2/2 | 5.9% / 1.54% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.tokyonight-dark` Theme tokyonight (dark) | theme | ported | ported | 2/2 | 2/2 | 7.6% / 1.49% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.tokyonight-light` Theme tokyonight (light) | theme | ported | ported | 2/2 | 2/2 | 5.9% / 1.53% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.ayu-dark` Theme ayu (dark) | theme | ported | ported | 2/2 | 2/2 | 5.5% / 1.48% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.ayu-light` Theme ayu (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.56% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.one-dark-dark` Theme one-dark (dark) | theme | ported | ported | 2/2 | 2/2 | 7.6% / 1.43% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.one-dark-light` Theme one-dark (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.60% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.github-dark` Theme github (dark) | theme | ported | ported | 2/2 | 2/2 | 7.2% / 1.49% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.github-light` Theme github (light) | theme | ported | ported | 2/2 | 2/2 | 5.5% / 1.63% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |

### Driven interactions and literal results

- `rail.project-list` (frames `/tmp/gpuix-g6/out/full/rail-project-list/`):
  - `a-dashboard`: present "alpha": web pass, gpuix pass; present "beta": web pass, gpuix pass; present "gamma": web pass, gpuix pass; present "delta": web pass, gpuix pass; present "What should we do in alpha?": web pass, gpuix pass
  - `b-switch-beta`: click #project-item-m1-beta (web ok; gpuix ok via testid); present "What should we do in beta?": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass; gone "Loading model…": web pass, gpuix pass; gone "Composer unavailable": web pass, gpuix pass
- `rail.project-menu` (frames `/tmp/gpuix-g6/out/full/rail-project-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: right-click #project-item-m1-beta (web ok; gpuix ok via testid); present "Rename": web pass, gpuix pass
- `rail.project-rename` (frames `/tmp/gpuix-g6/out/full/rail-project-rename/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-rename`: right-click #project-item-m1-gamma (web ok; gpuix ok via testid); click "Rename" (web ok; gpuix ok via text); click [data-testid="shell-rail"] input (web ok; gpuix ok via web-point); press ctrl-a (web ok; gpuix ok via key); type "gamma-renamed" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); present "gamma-renamed": web pass, gpuix pass
- `rail.project-remove` (frames `/tmp/gpuix-g6/out/full/rail-project-remove/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-confirm`: right-click #project-item-m1-delta (web ok; gpuix ok via testid); click "Delete" (web ok; gpuix ok via text); present "Delete Project": web pass, gpuix pass
  - `c-removed`: click [Delete] (web ok; gpuix ok via web-point); gone "delta": web pass, gpuix pass
- `rail.project-colour` (frames `/tmp/gpuix-g6/out/full/rail-project-colour/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: right-click #project-item-m1-beta (web ok; gpuix ok via testid); click "Change Color" (web ok; gpuix ok via text); present "Select Color": web pass, gpuix pass
- `rail.project-reorder` (frames `/tmp/gpuix-g6/out/full/rail-project-reorder/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-dragged`: drag #project-item-m1-gamma -> #project-item-m1-alpha (web ok; gpuix ok via testid); wait 500 ms (web ok; gpuix ok via none); present "alpha < gamma < beta": web pass, gpuix pass
- `rail.add-menu` (frames `/tmp/gpuix-g6/out/full/rail-add-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [Add project or folder group] (web ok; gpuix ok via web-point); present "New project": web pass, gpuix pass
  - `c-modal`: click "New project" (web ok; gpuix ok via text); present "Create": web pass, gpuix pass
- `rail.collapse` (frames `/tmp/gpuix-g6/out/full/rail-collapse/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-collapsed`: click [Expand or collapse projects] (web ok; gpuix ok via web-point); gone "Projects": web pass, gpuix pass
- `rail.project-settings` (frames `/tmp/gpuix-g6/out/full/rail-project-settings/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-beta`: click #project-item-m1-beta (web ok; gpuix ok via testid); present "What should we do in beta?": web pass, gpuix pass
  - `c-settings`: click [Settings for beta] (web ok; gpuix ok via web-point); present "Basic project identification and location.": web pass, gpuix pass
- `side.chats` (frames `/tmp/gpuix-g6/out/full/side-chats/`):
  - `a-chats`: present "How does the web client decide which routes rend": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass
- `side.chats-search` (frames `/tmp/gpuix-g6/out/full/side-chats-search/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-miss`: click input[placeholder^="Search chats"] (web ok; gpuix ok via web-point); type "zzz-no-match" (web ok; gpuix ok via key); gone "How does the web client decide which routes rend": web pass, gpuix pass
  - `c-hit`: press ctrl-a (web ok; gpuix ok via key); type "routes" (web ok; gpuix ok via key); present "How does the web client decide which routes rend": web pass, gpuix pass
- `side.chat-card-menu` (frames `/tmp/gpuix-g6/out/full/side-chat-card-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: right-click "How does the web client decide which routes rend" (web ok; gpuix ok via text); present "Open in split": web pass, gpuix pass; present "Copy Path": web pass, gpuix pass; present "Delete Chat": web pass, gpuix pass
- `side.workspace-switcher` (frames `/tmp/gpuix-g6/out/full/side-workspace-switcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Workspace] (web ok; gpuix ok via web-point); present "Current checkout": web pass, gpuix pass
- `side.hide` (frames `/tmp/gpuix-g6/out/full/side-hide/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-hidden`: click [Hide side panel] (web ok; gpuix ok via web-point); gone "How does the web client decide which routes rend": web pass, gpuix pass
- `explorer.tree` (frames `/tmp/gpuix-g6/out/full/explorer-tree/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "src": web pass, gpuix pass; present "docs": web pass, gpuix pass; present "README.md": web pass, gpuix pass; present "notes.txt": web pass, gpuix pass
- `explorer.expand` (frames `/tmp/gpuix-g6/out/full/explorer-expand/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "src": web pass, gpuix pass
  - `c-expanded`: click "src" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass; present "utils.ts": web pass, gpuix pass
- `explorer.context-menu` (frames `/tmp/gpuix-g6/out/full/explorer-context-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-menu`: right-click "README.md" (web ok; gpuix ok via text); present "Rename": web pass, gpuix pass; present "Delete": web pass, gpuix pass
- `explorer.drag` (frames `/tmp/gpuix-g6/out/full/explorer-drag/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "notes.txt": web pass, gpuix pass; present "docs": web pass, gpuix pass
  - `c-dropped`: drag "notes.txt" -> [data-pane-content] (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "untracked notes": web pass, gpuix FAIL
- `editor.code` (frames `/tmp/gpuix-g6/out/full/editor-code/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-open`: click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
- `editor.code-edit` (frames `/tmp/gpuix-g6/out/full/editor-code-edit/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "Explorer" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
  - `c-typed`: click "VERSION" (web ok; gpuix ok via web-point); press end (web ok; gpuix ok via key); type " // edited" (web ok; gpuix ok via key); present "// edited": web pass, gpuix FAIL
- `editor.markdown` (frames `/tmp/gpuix-g6/out/full/editor-markdown/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); click "docs" (web ok; gpuix ok via text); present "guide.md": web pass, gpuix pass
  - `c-open`: click "guide.md" (web ok; gpuix ok via text); present "Alpha guide": web pass, gpuix pass; present "Setup": web pass, gpuix pass
- `editor.tabs` (frames `/tmp/gpuix-g6/out/full/editor-tabs/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix not run
  - `b-two`: click "Explorer" (web ok; gpuix not run); click "README.md" (web ok; gpuix not run); click "src" (web ok; gpuix not run); click "app.ts" (web ok; gpuix not run); present "export function greet": web pass, gpuix not run
  - `c-back`: click [role="tab"]:has-text("README.md") (web ok; gpuix not run); present "The matrix project.": web pass, gpuix not run
  - gpuix error: Error: Timed out after 2 seconds waiting for the automation bounds query
- `git.changes` (frames `/tmp/gpuix-g6/out/full/git-changes/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass; present "README.md": web pass, gpuix pass; present "notes.txt": web pass, gpuix pass
- `git.amend` (frames `/tmp/gpuix-g6/out/full/git-amend/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "Amend last commit": web pass, gpuix pass
  - `c-label`: click "Amend last commit" (web ok; gpuix ok via text); wait 400 ms (web ok; gpuix ok via none); present "Amend commit": web pass, gpuix pass
  - `d-box`: click input[type="checkbox"] (web ok; gpuix ok via web-point); wait 400 ms (web ok; gpuix ok via none); gone "Amend commit": web pass, gpuix pass
- `git.diff` (frames `/tmp/gpuix-g6/out/full/git-diff/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-diff`: click "README.md" (web ok; gpuix ok via text); present "An unstaged line.": web pass, gpuix pass
- `git.stage` (frames `/tmp/gpuix-g6/out/full/git-stage/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-staged`: click [Stage changes] (web ok; gpuix ok via web-point); present "README.md": web pass, gpuix pass
- `git.unstage` (frames `/tmp/gpuix-g6/out/full/git-unstage/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-unstaged`: click [Unstage changes] (web ok; gpuix ok via web-point); present "app.ts": web pass, gpuix pass
- `git.discard` (frames `/tmp/gpuix-g6/out/full/git-discard/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-confirm`: click [Discard changes] (web ok; gpuix ok via web-point); present "Discard": web pass, gpuix pass
- `git.commit` (frames `/tmp/gpuix-g6/out/full/git-commit/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-message`: click input[placeholder="Summary (required)"] (web ok; gpuix ok via web-point); type "bump version" (web ok; gpuix ok via key)
  - `d-committed`: click [Commit to main] (web ok; gpuix ok via web-point); gone "app.ts": web pass, gpuix pass
- `git.branch-picker` (frames `/tmp/gpuix-g6/out/full/git-branch-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: click [Switch git branch] (web ok; gpuix ok via web-point); present "feature/login": web pass, gpuix pass
- `git.worktree-create` (frames `/tmp/gpuix-g6/out/full/git-worktree-create/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-switcher`: click [Workspace] (web ok; gpuix ok via web-point); present "main": web pass, gpuix pass
  - `c-typed`: type "feat-matrix" (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none)
- `chat.transcript` (frames `/tmp/gpuix-g6/out/full/chat-transcript/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "One more place parses it": web pass, gpuix FAIL; present "Changed files": web pass, gpuix pass
- `chat.scroll-top` (frames `/tmp/gpuix-g6/out/full/chat-scroll-top/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "One more place parses it": web pass, gpuix FAIL
  - `c-top`: wheel -20000 over "One more place parses it" (web ok; gpuix ok via web-point); wait 1200 ms (web ok; gpuix ok via none); present "Three call sites depend on it": web pass, gpuix FAIL
- `chat.new-chat` (frames `/tmp/gpuix-g6/out/full/chat-new-chat/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-new`: click [New chat] (web ok; gpuix ok via web-point); present "Chat Scenario Agent": web pass, gpuix pass
- `chat.agent-launcher` (frames `/tmp/gpuix-g6/out/full/chat-agent-launcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click button[aria-label^="Agent and model"] (web ok; gpuix ok via web-point); present "This agent gives no model": web pass, gpuix pass
- `chat.send` (frames `/tmp/gpuix-g6/out/full/chat-send/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-typed`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "Explain the router" (web ok; gpuix ok via key); present "Explain the router": web pass, gpuix pass
  - `c-reply`: press enter (web ok; gpuix ok via key); wait 4000 ms (web ok; gpuix ok via none); present "The router docs cover the hash variant in more depth": web pass, gpuix FAIL
- `chat.model-selector` (frames `/tmp/gpuix-g6/out/full/chat-model-selector/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1000 ms (web ok; gpuix ok via none); present "Chat Scenario Agent": web pass, gpuix pass
- `chat.plan` (frames `/tmp/gpuix-g6/out/full/chat-plan/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-reply`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix plan" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 3000 ms (web ok; gpuix ok via none); present "Here is the plan for the router work.": web pass, gpuix FAIL
  - `c-panel`: present "Plan": web pass, gpuix pass; present "Read the router module": web pass, gpuix pass; present "Write the hash router tests": web pass, gpuix pass; present "Update the router docs": web pass, gpuix pass
- `chat.permission` (frames `/tmp/gpuix-g6/out/full/chat-permission/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-prompt`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix permission" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 3000 ms (web ok; gpuix ok via none); present "Run the router test suite": web pass, gpuix pass; present "Allow": web pass, gpuix pass; present "Reject": web pass, gpuix pass
  - `c-allowed`: click "Allow" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "Permission answer: allow-once": web pass, gpuix FAIL; gone "Reject": web pass, gpuix pass
- `chat.queue` (frames `/tmp/gpuix-g6/out/full/chat-queue/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-holding`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix hold" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 2500 ms (web ok; gpuix ok via none); present "Holding this turn open for the queue.": web pass, gpuix FAIL
  - `c-queued`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "queued follow-up" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 1200 ms (web ok; gpuix ok via none); present "Queued": web pass, gpuix pass; present "queued follow-up": web pass, gpuix pass
- `composer.mention` (frames `/tmp/gpuix-g6/out/full/composer-mention/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "@" (web ok; gpuix ok via key); present "No files or folders match": web pass, gpuix pass
- `composer.slash` (frames `/tmp/gpuix-g6/out/full/composer-slash/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "/" (web ok; gpuix ok via key); present "Skills": web pass, gpuix pass
- `composer.attach` (frames `/tmp/gpuix-g6/out/full/composer-attach/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-click`: click [Attach files] (web ok; gpuix ok via web-point)
- `terminal.open` (frames `/tmp/gpuix-g6/out/full/terminal-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none); present "Terminal": web pass, gpuix pass
- `terminal.type` (frames `/tmp/gpuix-g6/out/full/terminal-type/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-echo`: type "echo matrix-$((6*7)) " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
- `terminal.vim-replies` (frames `/tmp/gpuix-g6/out/full/terminal-vim-replies/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-vim`: type "vim -u NONE -N notes.txt " (web ok; gpuix ok via key); wait 2500 ms (web ok; gpuix ok via none)
  - `d-quit`: press escape (web ok; gpuix ok via key); type ":q! " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
- `terminal.file-link` (frames `/tmp/gpuix-g6/out/full/terminal-file-link/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-echo`: type "clear && echo src/app.ts " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
  - `d-link`: ctrl-click .xterm-screen (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none); present "export function greet": web pass, gpuix FAIL
- `terminal.new-tab-menu` (frames `/tmp/gpuix-g6/out/full/terminal-new-tab-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [New tab] (web ok; gpuix ok via web-point); present "Terminal": web pass, gpuix pass
- `terminal.tab-reorder` (frames `/tmp/gpuix-g6/out/full/terminal-tab-reorder/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); click [New tab] (web ok; gpuix ok via web-point); click [Bash] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
  - `c-reordered`: drag "Terminal 2" -> [role="tab"]:has-text("Terminal 1") (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none)
- `terminal.split` (frames `/tmp/gpuix-g6/out/full/terminal-split/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); click [New tab] (web ok; gpuix ok via web-point); click [Bash] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
  - `c-split`: drag "Terminal 2" -> [data-pane-content] (web ok; gpuix ok via text); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
- `statusbar.items` (frames `/tmp/gpuix-g6/out/full/statusbar-items/`):
  - `a-dashboard`: present "main": web pass, gpuix pass; present "Terminal": web pass, gpuix pass
- `statusbar.context-bar` (frames `/tmp/gpuix-g6/out/full/statusbar-context-bar/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-popover`: click [Context bar settings] (web ok; gpuix ok via web-point); present "Branch": web pass, gpuix pass
- `statusbar.connection` (frames `/tmp/gpuix-g6/out/full/statusbar-connection/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-hover`: hover [Connected] (web ok; gpuix ok via web-point); wait 1200 ms (web ok; gpuix ok via none)
- `remote.access-popover`: StatusBar renders RemoteAccessPopover only under isTauriContext(); the web client has none to compare, and GPUIX would need the desktop host role from the server
- `settings.interface` (frames `/tmp/gpuix-g6/out/full/settings-interface/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Interface" (web ok; gpuix ok via text); present "Interface zoom": web pass, gpuix pass
- `settings.notifications` (frames `/tmp/gpuix-g6/out/full/settings-notifications/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Notifications" (web ok; gpuix ok via text); present "Notify when a terminal agent finishes": web pass, gpuix pass
- `settings.editor` (frames `/tmp/gpuix-g6/out/full/settings-editor/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Editor" (web ok; gpuix ok via text); present "Auto save delay": web pass, gpuix pass
- `settings.appearance` (frames `/tmp/gpuix-g6/out/full/settings-appearance/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Appearance" (web ok; gpuix ok via text); present "Font size": web pass, gpuix pass
- `settings.shell` (frames `/tmp/gpuix-g6/out/full/settings-shell/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Shell" (web ok; gpuix ok via text); present "Default shell": web pass, gpuix pass
- `settings.terminal-profiles` (frames `/tmp/gpuix-g6/out/full/settings-terminal-profiles/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Profiles" (web ok; gpuix ok via text); present "No terminal profiles": web pass, gpuix pass
- `settings.ai-agents` (frames `/tmp/gpuix-g6/out/full/settings-ai-agents/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Agent chats" (web ok; gpuix ok via text); present "Close idle chats after": web pass, gpuix pass
- `settings.skills` (frames `/tmp/gpuix-g6/out/full/settings-skills/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Skills" (web ok; gpuix ok via text); present "Skills": web pass, gpuix pass
- `settings.provider` (frames `/tmp/gpuix-g6/out/full/settings-provider/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Accounts" (web ok; gpuix ok via text); present "1 account": web pass, gpuix pass
- `settings.mcp-servers` (frames `/tmp/gpuix-g6/out/full/settings-mcp-servers/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "MCP servers" (web ok; gpuix ok via text); present "MCP servers": web pass, gpuix pass
- `settings.shortcuts` (frames `/tmp/gpuix-g6/out/full/settings-shortcuts/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Keyboard shortcuts" (web ok; gpuix ok via text); present "Command Palette": web pass, gpuix pass
- `settings.diagnostics` (frames `/tmp/gpuix-g6/out/full/settings-diagnostics/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Logs" (web ok; gpuix ok via text); present "Application log": web pass, gpuix pass
- `settings.reset` (frames `/tmp/gpuix-g6/out/full/settings-reset/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Reset" (web ok; gpuix ok via text); present "Reset all settings": web pass, gpuix pass
- `palette.open` (frames `/tmp/gpuix-g6/out/full/palette-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: press ctrl-k (web ok; gpuix ok via key); present "App Preferences": web pass, gpuix pass; present "New Terminal": web pass, gpuix pass
  - `c-filter`: type "theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `d-escape`: press escape (web ok; gpuix ok via key); gone "Change Color Theme": web pass, gpuix pass
- `palette.type-ahead` (frames `/tmp/gpuix-g6/out/full/palette-type-ahead/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-typed`: press ctrl-k (web ok; gpuix ok via key); type "theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
- `palette.new-terminal` (frames `/tmp/gpuix-g6/out/full/palette-new-terminal/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "New Terminal" (web ok; gpuix ok via key); present "New Terminal": web pass, gpuix pass
  - `c-run`: click "New Terminal" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Terminal": web pass, gpuix pass
- `palette.agent-launcher` (frames `/tmp/gpuix-g6/out/full/palette-agent-launcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Agent Launcher" (web ok; gpuix ok via key); present "Agent Launcher": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Agent Launcher" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Chat Scenario Agent": web pass, gpuix pass
- `palette.save-snapshot` (frames `/tmp/gpuix-g6/out/full/palette-save-snapshot/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Save Workspace Snapshot" (web ok; gpuix ok via key); present "Save Workspace Snapshot": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Save Workspace Snapshot" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Snapshot": web pass, gpuix pass
- `palette.open-canvas` (frames `/tmp/gpuix-g6/out/full/palette-open-canvas/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Open Canvas" (web ok; gpuix ok via key); present "Open Canvas": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Open Canvas" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Canvas": web pass, gpuix pass; present "Ready": web pass, gpuix pass
- `palette.project-settings` (frames `/tmp/gpuix-g6/out/full/palette-project-settings/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Project Settings" (web ok; gpuix ok via key); present "Project Settings": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Project Settings" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Basic project identification and location.": web pass, gpuix pass
- `palette.app-preferences` (frames `/tmp/gpuix-g6/out/full/palette-app-preferences/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "App Preferences" (web ok; gpuix ok via key); present "App Preferences": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "App Preferences" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Interface zoom": web pass, gpuix pass
- `palette.switch-project` (frames `/tmp/gpuix-g6/out/full/palette-switch-project/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "beta" (web ok; gpuix ok via key); present "beta": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: press enter (web ok; gpuix ok via key); wait 1200 ms (web ok; gpuix ok via none); present "What should we do in beta?": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass; gone "Loading model…": web pass, gpuix pass; gone "Composer unavailable": web pass, gpuix pass
- `palette.command-history` (frames `/tmp/gpuix-g6/out/full/palette-command-history/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Command History" (web ok; gpuix ok via key); present "Command History": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Command History" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Command History": web pass, gpuix pass
- `palette.color-theme` (frames `/tmp/gpuix-g6/out/full/palette-color-theme/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Change Color Theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Change Color Theme" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Dracula": web pass, gpuix pass
- `palette.shortcut-menu` (frames `/tmp/gpuix-g6/out/full/palette-shortcut-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Open Shortcut Menu" (web ok; gpuix ok via key); present "Open Shortcut Menu": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Open Shortcut Menu" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Shortcut Menu": web pass, gpuix pass
- `palette.report-bug` (frames `/tmp/gpuix-g6/out/full/palette-report-bug/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Report a Bug" (web ok; gpuix ok via key); present "Report a Bug": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Report a Bug" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Report a bug": web pass, gpuix pass
- `shortcuts.menu` (frames `/tmp/gpuix-g6/out/full/shortcuts-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Open keyboard shortcuts menu] (web ok; gpuix ok via web-point); present "Shortcut Menu": web pass, gpuix pass
- `shortcuts.settings-shortcut` (frames `/tmp/gpuix-g6/out/full/shortcuts-settings-shortcut/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: press alt-, (GPUIX ctrl-,) (web ok; gpuix ok via key); present "Interface zoom": web pass, gpuix pass
  - `c-escape`: press escape (web ok; gpuix ok via key); wait 600 ms (web ok; gpuix ok via none); gone "Interface zoom": web pass, gpuix pass
- `shortcuts.toggle-projects` (frames `/tmp/gpuix-g6/out/full/shortcuts-toggle-projects/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-shift-b (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "gamma": web pass, gpuix pass
- `shortcuts.toggle-side-panel` (frames `/tmp/gpuix-g6/out/full/shortcuts-toggle-side-panel/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-b (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "Explorer": web pass, gpuix pass
- `shortcuts.theme-picker` (frames `/tmp/gpuix-g6/out/full/shortcuts-theme-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-alt-t (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "Color Themes": web pass, gpuix pass
- `shortcuts.zoom-in` (frames `/tmp/gpuix-g6/out/full/shortcuts-zoom-in/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press alt-= (GPUIX ctrl-=) (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `shortcuts.desktop-keymap`: No web reference: the web client swaps browser-reserved keys for Alt combos, and GPUIX inherits that keymap because it is not a Tauri context
- `theme.picker` (frames `/tmp/gpuix-g6/out/full/theme-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Color themes] (web ok; gpuix ok via web-point); present "Dracula": web pass, gpuix pass; present "Nord": web pass, gpuix pass
- `dialogs.bug-report` (frames `/tmp/gpuix-g6/out/full/dialogs-bug-report/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Report a bug] (web ok; gpuix ok via web-point); present "Report a bug": web pass, gpuix pass
- `canvas.open` (frames `/tmp/gpuix-g6/out/full/canvas-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Open canvas] (web ok; gpuix ok via web-point); present "Canvas": web pass, gpuix pass; present "Ready": web pass, gpuix pass
- `browser.pane`: Browser tabs are Tauri native webviews; the web client offers no New Browser Tab, so there is no reference, and GPUIX 0.11 has no webview element
- `notifications.toast` (frames `/tmp/gpuix-g6/out/full/notifications-toast/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: click [Switch git branch] (web ok; gpuix ok via web-point); click "Create branch from" (web ok; gpuix ok via text)
  - `c-toast`: type "toast-branch" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); present "Created and checked out toast-branch": web pass, gpuix pass
- `ssh.workspace`: No web reference: SSH needs a host-local client (useHostGate(canUseHostSsh)), which a browser never is; R2 drove the GPUIX flow against a throwaway sshd (reports/r2-shots)
- `settings.accounts-claude`: No web reference: Claude account management needs a host-local client, which a browser never is; the R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path
- `update.toast`: Both render only when isTauriContext() is true (App.tsx WhatsNewModal, UpdateAvailableToast); the web client never shows them, so there is no reference to compare against
- `snapshots.page`: The desktop shell has no link to the route; only the mobile drawer navigates to it, and GPUIX cannot start on a hash route yet
- `theme.termul-dark` (frames `/tmp/gpuix-g6/out/full/theme-termul-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.termul-light` (frames `/tmp/gpuix-g6/out/full/theme-termul-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.cursor-dark` (frames `/tmp/gpuix-g6/out/full/theme-cursor-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.cursor-light` (frames `/tmp/gpuix-g6/out/full/theme-cursor-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.catppuccin-dark` (frames `/tmp/gpuix-g6/out/full/theme-catppuccin-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.catppuccin-light` (frames `/tmp/gpuix-g6/out/full/theme-catppuccin-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.dracula-dark` (frames `/tmp/gpuix-g6/out/full/theme-dracula-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.dracula-light` (frames `/tmp/gpuix-g6/out/full/theme-dracula-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.nord-dark` (frames `/tmp/gpuix-g6/out/full/theme-nord-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.nord-light` (frames `/tmp/gpuix-g6/out/full/theme-nord-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.gruvbox-dark` (frames `/tmp/gpuix-g6/out/full/theme-gruvbox-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.gruvbox-light` (frames `/tmp/gpuix-g6/out/full/theme-gruvbox-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.tokyonight-dark` (frames `/tmp/gpuix-g6/out/full/theme-tokyonight-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.tokyonight-light` (frames `/tmp/gpuix-g6/out/full/theme-tokyonight-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.ayu-dark` (frames `/tmp/gpuix-g6/out/full/theme-ayu-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.ayu-light` (frames `/tmp/gpuix-g6/out/full/theme-ayu-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.one-dark-dark` (frames `/tmp/gpuix-g6/out/full/theme-one-dark-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.one-dark-light` (frames `/tmp/gpuix-g6/out/full/theme-one-dark-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.github-dark` (frames `/tmp/gpuix-g6/out/full/theme-github-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.github-light` (frames `/tmp/gpuix-g6/out/full/theme-github-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass

<!-- matrix:end -->
