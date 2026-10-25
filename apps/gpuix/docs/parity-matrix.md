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
bun run parity:matrix                    # every surface, about 45 minutes
bun run parity:matrix --only git.diff,chat.send
bun run parity:matrix --area terminal
bun run parity:matrix --report-only      # regenerate this page from results.json and review.ts
bun tools/matrix/probe.ts <surface-id>   # web only: what the DOM offers to act on, per step
bun tools/matrix/pair.ts [surface-id]    # web | GPUIX side by side, for review
```

Output goes to `parity-out/matrix/<surface>/<step>/` (`web.png`, `gpuix.png`,
`diff.png`, the region crops and `pair.png`) and `parity-out/matrix/results.json`.
A partial run updates only the surfaces it ran. `results.json` and the PNGs
are not committed (`parity-out/` is ignored); this page is the record. A
surface missing from `results.json` keeps the status, measured columns and
interaction lines this page already shows for it, so a partial run in a fresh
checkout does not blank the rest. Server and client state live
under `/tmp/gpuix-m1` (`--state` or `GPUIX_STATE_ROOT` moves them) and are
deleted at the end of the run.

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

These findings are from the rows below, which came from three batches. Most
surfaces ran at eceaec17 (E1, the native editor). The chat, palette,
shortcut, toast and vim rows ran again after the matrix gained its agent
proxy and web-keymap shortcuts. The drag, split, tab and editor rows ran
again at fce9a3e2 (D1 drag and drop, R1 to R3 host-local SSH and accounts).
The chat, side.chats and settings select rows ran again at 3044bfd2 (G2: O5
to O8). The editor.markdown, editor.tabs, git.commit, notifications.toast and
settings.diagnostics rows ran again at 2ecce932 (G4: K2, O10, E2, O4, O9). A
full rerun at one head is the first follow-up.

**G4 and the keymap.** Since G4 the GPUIX client takes the desktop keymap, like
Tauri: Ctrl+, opens Preferences and Ctrl+= zooms, and the web's Alt+, and
Alt+= do nothing. The shortcuts.settings-shortcut and shortcuts.zoom-in steps
still press the web keys in both clients, so their reviewed status rests on
`tools/parity/workspace-checks.ts` (Ctrl+, and Ctrl+R) and
`tools/parity/zoom-check.ts` (Ctrl+= scales the rail from 200 to 220 px in
both clients, and Ctrl+0 restores the frame exactly) until the steps take a
key per client.

**Where it stands.** The usage-weighted score is 59.7 % over all 115
surfaces and 61.7 % over the 106 that have a web reference. Unweighted, it is
56.5 % and 61.3 %. A score this low does not mean the client is unusable.
Most of the 38 partial surfaces work end to end and lose half their score to
one cosmetic difference that repeats across many screens, such as the missing
backdrop blur, warm-tinted word runs or truncated tab titles.

**What is at parity.** The composer (mention, slash and attach menus), all 20
themes on the dashboard, terminal typing and Ctrl+click file links, the git
branch picker and worktree switcher, explorer tree and file drops, the code
editor, and the rail and side-panel shortcuts match. The chat flows that the
scenario agent could not reach before (plan panel, permission prompt, prompt
queue) now work in GPUIX the same way as on the web, and since G2 their short
transcripts start at the top; truncated tab titles (C15) and prose (O5)
keep them partial.

**What hurts most.** C2 is the largest gap. Radix menus, popovers and
context menus do not open through compat, which takes out the rail's project
menu, rename, remove, colour and settings, the add-project menu, the agent
and model popover (it crashes the pane), and the context-bar popover. Landing
C2 alone would add about 11 points. Next come the chat surfaces, which carry
the most weight. G2 fixed the card overlap (O7), wheel scrolling and short
transcript anchoring (O6) and the closed select (O8); prose still paints
links in the text colour, inline code at body size and no italics, which
native markdown cannot be themed to change (O5, needs GPUIX). Pane tabs truncate to three letters (C15), so two
terminals cannot be told apart. Enter does not submit text fields or run the
palette's selected command (C12), and keys typed straight after Ctrl+K are
lost (C11).

**After G1 (branch gpuix/g1).** The G1 unit reran its surfaces and their
neighbours at one head. Menus, popovers and context menus open, including
the agent and model popover (C2). Enter in a field runs its keydown handlers
and submits its form, so the palette runs the selected row and Create branch
works (C12). A tooltip no longer opens on the focus a click gives its trigger
(C4). Dialog bodies lay out in full: a `flex-1` body in a content-sized
column takes its content height, and a grid with no column template gets one
`1fr` track (C9). Escape closes Preferences in both clients after a web fix:
SettingsModal took the Shortcuts section's idle recorders for a recording in
progress (C10). Keys typed in the same burst as Ctrl+K reach the palette
filter (C11). The modal scrim already had the web dim and colour (a flat
patch reads 4,5,6 on the web and 5,5,6 in GPUIX). The web also blurs the page
by 4 px, and GPUIX 0.11 has no backdrop filter, so C6 is a missing
capability. Drawing it would need a GPUI renderer pass: render the scene
below the layer to an offscreen texture, blur it with a separable Gaussian
shader, and composite it under the layer, plus a style field to request it.
Ported surfaces went from 46 to 56 and broken from 22 to 7. The usage-weighted
score went from 59.7 % to 71.7 % over all surfaces.

**What 99 % parity requires.** On the usage-weighted score, 99 % allows
losing about one point of the 100 weight. The ranked units below, if each one
fixed every surface it names, would reach about 98.3 %. The remaining points
are surfaces that have no web reference (SSH, Claude accounts, the remote
access popover, the update toast, the desktop keymap, snapshots page) or that
need a capability GPUIX 0.11 lacks (the browser pane and the canvas need a
webview, V1 and V2). Three kinds of work close that gap.

1. Land the compat and override units in rank order. C2, O5 and C15
   carry most of the weight, and C6, C8 and C4 are small but repeat across
   many surfaces.
2. Give the Tauri-only surfaces a reference. That means a desktop screenshot
   harness for the Tauri app, or accepting R2's functional evidence for SSH
   and a GPUIX-only check for the rest.
3. Decide the webview question for the browser pane and the canvas. That is
   a GPUIX capability, not a Termul change.

Ninety-nine percent also means every partial surface reaches ported, so the
cosmetic units count even when no single one looks important.

**Terminal query replies after vim.** The O1 note said GPUIX echoed terminal
query replies (`^[[>0;276;0c ... rgb:`) into the prompt after its T1 fixture
ran vim. Here both clients ran the fixture's own command, `vim -u NONE -N
notes.txt` and then `:q!`, typed into the full app. Both returned to a clean
prompt with no echoed replies. The echo does not reproduce in the full app.
It is most likely a fixture artifact, because the fixture writes its inputs
to the PTY back to back. That cause is inferred, since this unit did not
rerun the fixture. It is not counted as a gap.

**How far to trust a row.** GPUIX text checks read the automation tree.
Natively painted text (chat prose, the editor, terminal cells) is not in that
tree, so those checks fail even when the text is on screen. Those rows were
decided from the PNG pairs. The theme.tokyonight-light row crashed once with
`Timed out after 2 seconds waiting for the automation bounds query` and
booted cleanly on rerun (C13). The web reference also flakes. The ayu-light
dashboard once showed "Composer unavailable". Every pair was looked at
before it was classified.

**Not covered.** The matrix does not drive these, so they are not scored.

- Settings toggles and inputs inside each section. Only navigation and
  content are compared.
- The new project modal and folder groups, which are unreachable in GPUIX
  while the add menu is broken (C2).
- Git stash, history view, and conflict resolution.
- Editor save, Source mode editing in markdown, and big files.
- Composer pills with real files, because a bare @ lists no files on this
  server in either client.
- Panel divider resize. D1 reports that it works and persists the size.
- The mobile layout, the snapshots page and what's new.

<!-- matrix:begin (generated by `bun run parity:matrix`; edit tools/matrix/review.ts, not this block) -->

Surfaces: 116 (ported 71, partial 36, broken 0, blocked 9, unverified 0, pending-unit 0).

| Score | All surfaces (pending, blocked and unverified count 0) | Measured surfaces only |
| --- | ---: | ---: |
| Unweighted | 76.7% | 83.2% |
| Usage-weighted | 82.2% | 85.4% |

### By area

| Area | Weight | Surfaces | Ported | Partial | Broken | Blocked, pending or unverified | Area score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chat | 17 | 9 | 3 | 6 | 0 | 0 | 66.7% |
| composer | 14 | 3 | 3 | 0 | 0 | 0 | 100.0% |
| terminal | 14 | 7 | 5 | 2 | 0 | 0 | 85.7% |
| rail | 9 | 10 | 7 | 3 | 0 | 0 | 85.0% |
| git | 9 | 9 | 8 | 1 | 0 | 0 | 94.4% |
| explorer | 7 | 4 | 4 | 0 | 0 | 0 | 100.0% |
| editor | 7 | 4 | 3 | 1 | 0 | 0 | 87.5% |
| side-panel | 5 | 5 | 5 | 0 | 0 | 0 | 100.0% |
| settings | 4 | 14 | 0 | 13 | 0 | 1 | 46.4% |
| statusbar | 3 | 3 | 3 | 0 | 0 | 0 | 100.0% |
| palette | 3 | 11 | 4 | 6 | 0 | 1 | 63.6% |
| theme | 2 | 21 | 21 | 0 | 0 | 0 | 100.0% |
| shortcuts | 1 | 7 | 4 | 2 | 0 | 1 | 71.4% |
| dialogs | 1 | 1 | 0 | 1 | 0 | 0 | 50.0% |
| browser | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| notifications | 1 | 2 | 1 | 0 | 0 | 1 | 50.0% |
| remote | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| snapshots | 0.5 | 2 | 0 | 1 | 0 | 1 | 25.0% |
| canvas | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| ssh | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |

### Ranked gaps

Rank is the reviewed impact (1 to 3) times the area weight.

| # | Surface | Status | Root cause class | Proposed unit | Rank | What differs |
| ---: | --- | --- | --- | --- | ---: | --- |
| 1 | `chat.transcript` | partial | missing GPUIX capability | O5 native prose styling | 51 | The transcript, code card, task list, Worked for row and Changed files bar all render. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. The text check fails only because natively painted text is not in the automation tree. |
| 2 | `chat.scroll-top` | partial | missing GPUIX capability | O5 native prose styling | 34 | One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. The text check fails only because natively painted text is not in the automation tree. |
| 3 | `chat.send` | partial | missing GPUIX capability | O5 native prose styling | 34 | Typing and Enter start a chat and the scripted reply streams in both. Mermaid shows as source ("Mermaid diagrams are shown as source in this client") where the web draws the diagram. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| 4 | `chat.agent-launcher` | partial | compat translator gap | C2 menus and popovers | 17 | The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. In GPUIX the chip stretches across the panel and the more button wraps to a second line. |
| 5 | `chat.model-selector` | partial | missing GPUIX capability | O5 native prose styling | 17 | The running chat shows the agent chip and composer like the web. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. |
| 6 | `chat.queue` | partial | missing GPUIX capability | O5 native prose styling | 17 | A prompt sent while the turn runs shows under 1 Queued in both, and the stop button replaces send. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. |
| 7 | `terminal.open` | partial | compat translator gap | title tooltips (unassigned) | 14 | Terminal tab, its full "Terminal 1" title at the web width, and the prompt match (C15 fixed in G5). The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. The status-bar Terminal button's title tooltip paints under the pointer after the click; the web frame shows none. |
| 8 | `terminal.tab-reorder` | partial | needs diagnosis | click loss on a just-opened menu (unassigned) | 14 | Pane tabs read "Terminal 1" in full at the web width (C15 fixed in G5). In GPUIX the click on Bash in the open New tab menu was lost in 2 of 2 G5 runs (before and after the C15 change), so no second terminal opened and nothing was reordered; terminal.split runs the same steps and opened it. |
| 9 | `rail.project-reorder` | partial | compat translator gap | click after a Reorder drag; strip fade over the diff stat (unassigned) | 9 | Dragging gamma onto alpha reorders the list to alpha, gamma, beta in both (C3 fixed in G3: the framer-motion shim drives Reorder from pointer moves with framer's one-neighbour-per-move rule). The dragged row does not follow the pointer in GPUIX, which has no transforms; the list reorders live under it. After the drop the web opens gamma, the dragged row, and paints alpha and gamma in their hover state (gear and Ctrl+1/Ctrl+2). GPUIX stays on alpha: D1 withholds the click that ends a drag. GPUIX paints alpha hovered, but its +4 -1 diff stat shows through the action strip's fade (bg-gradient-to-l from-[var(--rail-keycap)] from-60%), so Ctrl+1 is drawn over it. |
| 10 | `rail.add-menu` | partial | missing GPUIX capability | C6 overlay backdrop | 9 | Clicking + opens the New project / New folder group menu and New project opens the Create New Project modal with the same fields in both. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| 11 | `rail.project-settings` | partial | missing GPUIX capability | C6 overlay backdrop | 9 | Clicking the gear opens Project settings with General and the same fields in both, with GPUIX automation and with real X input (--x11-input). The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. H1 fixed the lost gear click. GPUIX ends a hit test at the first absolutely placed or filled interactive box, and that box also blocks its own ancestors, so the row lost its hover as soon as its hover-revealed action strip painted under the pointer, hid the strip and the gear, and looped. The press landed on whichever frame was up. Compat now keeps an element hovered while a blocking box inside it is hovered (`src/compat/hover.ts`). `bun tools/clickloss/run.ts --trials 20` opens the modal 60/60 through automation and XTEST, against 27/60 on exp/gpuix-client at 9747b6c2. In the --x11-input frame the gear and its Project settings tooltip still paint above the modal. The automation frame has neither, and in clickloss traces the row, rail and gear get their leave once the scrim paints, so this is the hover settle catching up after the modal mounts (inferred). |
| 12 | `git.discard` | partial | missing GPUIX capability | C6 overlay backdrop | 9 | The confirm dialog matches. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| 13 | `editor.markdown` | partial | native override needed | E2 markdown preview parity | 7 | Preview has the "On this page" outline (G4): the heading and paragraph rows land on the web rows (126, 195, 257 px), heading sizes follow BlockNote (48/32 px). List items sit 1 px off and the bullet is the native one; the heading has no -0.018em letter spacing (GPUIX has none), so "Alpha guide" is 10 px wider. The tab reads "guide.md" in full at the web width (C15 fixed in G5). A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. |
| 14 | `settings.interface` | partial | missing GPUIX capability | C6 overlay backdrop | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 15 | `settings.notifications` | partial | compat translator gap | settings row layout (unassigned) | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. Row dividers inside a group are missing and rows sit tighter. |
| 16 | `settings.editor` | partial | compat translator gap | C6 overlay backdrop | 4 | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 17 | `settings.appearance` | partial | compat translator gap | C9 dialog body layout | 4 | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. Renderer and Scrollback descriptions now wrap normally beside the closed select. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 18 | `settings.shell` | partial | compat translator gap | C6 overlay backdrop | 4 | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 19 | `settings.terminal-profiles` | partial | missing GPUIX capability | C6 overlay backdrop | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 20 | `settings.ai-agents` | partial | compat translator gap | C9 dialog body layout | 4 | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The agents list shows No agents match while the web lists the registry. The rows lay out beside their selects once the settings card has measured itself; on a loaded host the frame can be grabbed before that (the first frame lays container queries out narrow), so the Close idle chats after row shows stacked with a full-width select in some runs (2 of 3 in G5). |
| 21 | `settings.skills` | partial | missing GPUIX capability | C6 overlay backdrop | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 22 | `settings.provider` | partial | compat translator gap | settings row layout (unassigned) | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. The usage line moves under the account instead of beside it. |
| 23 | `settings.mcp-servers` | partial | compat translator gap | settings row layout (unassigned) | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. The inline code in the footnote breaks onto its own line. |
| 24 | `settings.shortcuts` | partial | missing GPUIX capability | C6 overlay backdrop | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 25 | `settings.diagnostics` | partial | missing GPUIX capability | C6 overlay backdrop | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. Server version reads termul-server v0.4.52 in both: GPUIX asks the server (G4). |
| 26 | `settings.reset` | partial | missing GPUIX capability | C6 overlay backdrop | 4 | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 27 | `palette.type-ahead` | partial | compat translator gap | focus ring on focused fields (unassigned) | 3 | Typing "theme" straight after Ctrl+K filters the palette in both, and the rows rank the same (C16 fixed in G3: the cmdk shim scores with cmdk's command-score and sorts as cmdk does), Open Canvas first under Workspace. The step races in both clients: in some runs the web drops the first key ("heme") and in some GPUIX does (an empty filter); GPUIX failed this check in 5 of 9 G3 runs, 3 of 6 with the C16 change and 2 of 3 without it. The search field shows its focus underline as on the web (G5: the matrix makes the GPUIX window the active X window, as the Playwright page is focused; an inactive GPUI window gets no focus events). |
| 28 | `palette.open-canvas` | blocked | missing GPUIX capability | V1 canvas host | 3 | Opens the canvas tab in both; see canvas.open for why the canvas itself is not compared. |
| 29 | `palette.project-settings` | partial | missing GPUIX capability | C6 overlay backdrop | 3 | Project settings opens on General with the same fields. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| 30 | `palette.app-preferences` | partial | missing GPUIX capability | C6 overlay backdrop | 3 | Preferences opens on Interface. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| 31 | `palette.command-history` | partial | missing GPUIX capability | C6 overlay backdrop | 3 | The Command History modal, its scope picker and empty state match. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. The search field shows its focus ring as on the web (G5). |
| 32 | `palette.shortcut-menu` | partial | missing GPUIX capability | C6 overlay backdrop | 3 | Opens the Shortcut Menu in both. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| 33 | `palette.report-bug` | partial | missing GPUIX capability | C6 overlay backdrop | 3 | Opens the Report a bug dialog, laid out as in dialogs.bug-report. |
| 34 | `browser.pane` | blocked | missing GPUIX capability | V2 native webview | 2 | Not compared: browser tabs are Tauri webviews with no web-client reference, and GPUIX 0.11 has no webview element. Replacing Tauri loses the browser pane until a native webview exists. |
| 35 | `shortcuts.menu` | partial | missing GPUIX capability | C6 overlay backdrop | 1 | Shortcut Menu rows, descriptions and key chips match, including the blank Command History chip in both. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| 36 | `shortcuts.zoom-in` | partial | needs diagnosis | web zoom overflow (unassigned) | 1 | Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4's keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both). The zoomed web page runs past the window bottom, so its status bar is cut off and the dashboard heading sits 25 px lower; GPUIX keeps the status bar in the window. |
| 37 | `dialogs.bug-report` | partial | missing GPUIX capability | C6 overlay backdrop | 1 | The Report a bug dialog paints its Title, What happened, Screenshots and Preview sections at the web width and wraps the same lines. The Title field opens focused with its ring in both (G5: the matrix makes the GPUIX window the active X window, as the Playwright page is focused; an inactive GPUI window gets no focus events). The web draws a resize grip in the What happened corner; GPUIX has none. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| 38 | `canvas.open` | blocked | missing GPUIX capability | V1 canvas host | 1 | This server build ships no figcraft bundle, so the web tab shows the BUNDLE_MISSING error JSON; GPUIX stays on Loading editor... and paints neither that error nor an editor. The canvas is a figcraft iframe (CanvasMountLayer), which GPUIX 0.11 cannot host. |
| 39 | `update.toast` | blocked | native override needed | U1 GPUIX updater and what's new | 1 | Not compared: the update toast and the what's new modal render only under isTauriContext(), so neither client shows them (the web hides them by design). GPUIX shows its version like the web (Preferences, Logs: termul-server v0.4.52). A GPUIX update check against the release feed is not built yet. |
| 40 | `remote.access-popover` | blocked | server route needed | R4 desktop host role over the server | 0.5 | Not compared: the popover renders only under isTauriContext(), so the web client has no reference. |
| 41 | `palette.save-snapshot` | partial | missing GPUIX capability | C6 overlay backdrop | 0.5 | The Create Snapshot modal matches. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |

### Proposed units

Each unit with the surfaces its gaps name. Gain is the usage-weighted score (all surfaces) the matrix would report if every one of those surfaces became ported, everything else unchanged.

| # | Unit | Root cause class | Surfaces | Summed rank | Gain |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | O5 native prose styling | missing GPUIX capability | 5 | 153 | +4.7 |
| 2 | C6 overlay backdrop | missing GPUIX capability | 19 | 76.5 | +3.9 |
| 3 | C2 menus and popovers | compat translator gap | 1 | 17 | +0.9 |
| 4 | title tooltips (unassigned) | compat translator gap | 1 | 14 | +1.0 |
| 5 | click loss on a just-opened menu (unassigned) | needs diagnosis | 1 | 14 | +1.0 |
| 6 | settings row layout (unassigned) | compat translator gap | 3 | 12 | +0.4 |
| 7 | click after a Reorder drag; strip fade over the diff stat (unassigned) | compat translator gap | 1 | 9 | +0.5 |
| 8 | C9 dialog body layout | compat translator gap | 2 | 8 | +0.3 |
| 9 | E2 markdown preview parity | native override needed | 1 | 7 | +0.9 |
| 10 | V1 canvas host | missing GPUIX capability | 2 | 4 | +0.8 |
| 11 | focus ring on focused fields (unassigned) | compat translator gap | 1 | 3 | +0.1 |
| 12 | V2 native webview | missing GPUIX capability | 1 | 2 | +1.0 |
| 13 | web zoom overflow (unassigned) | needs diagnosis | 1 | 1 | +0.1 |
| 14 | U1 GPUIX updater and what's new | native override needed | 1 | 1 | +0.5 |
| 15 | R4 desktop host role over the server | server route needed | 1 | 0.5 | +0.5 |

If every listed unit landed and fixed its surfaces, the usage-weighted score would be 98.8%.

### Surfaces

Web and GPUIX columns count passed actions plus checks over the total. Mismatch is exact / perceptual for the last step: the full 1280x800 frame, and the region the surface names (measured in the web client, cropped from both frames).

| Surface | Area | Status | Auto | Web | GPUIX | Full mismatch | Region mismatch | Differences seen |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `rail.project-list` Project list and switching | rail | ported | ported | 7/7 | 7/7 | 5.7% / 0.95% | 3.2% / 0.59% | Same layout and order; switching to beta works by click, with GPUIX automation and with real X input (--x11-input). H1 fixed the lost clicks: `bun tools/clickloss/run.ts --trials 20` switches projects 60/60 by row click through automation and XTEST, against 41/60 on exp/gpuix-client at 9747b6c2. The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `rail.project-menu` Project context menu | rail | ported | ported | 3/3 | 3/3 | 7.1% / 1.19% | 7.5% / 1.75% | Right-click opens the project menu with the same rows, icons, submenu chevrons and red Delete, at the same place (G3: Radix opens a context menu 2 px right of the pointer). Row labels sit where the web puts them (G5: the " Label" text in a row's nested {icon}{children}{after} array is trimmed like any flex text run; it had kept its leading space, 3 px). Under the open menu GPUIX keeps the hovered beta row's gear and shortcut; the web hides them, since a modal Radix menu turns pointer events off on the page. |
| `rail.project-rename` Rename a project | rail | ported | ported | 8/8 | 8/8 | 6.6% / 1.10% | 6.1% / 0.80% | Rename from the context menu edits the row in place and Enter saves gamma-renamed in both. |
| `rail.project-remove` Remove a project | rail | ported | ported | 6/6 | 6/6 | 6.2% / 1.11% |  | Delete from the context menu asks for confirmation and removes delta in both. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| `rail.project-colour` Project colour picker | rail | ported | ported | 4/4 | 4/4 | 7.3% / 1.09% |  | Change Color opens the Select Color popover with the same nine swatches and the current one ringed. |
| `rail.project-reorder` Reorder projects by drag | rail | partial | ported | 4/4 | 4/4 | 7.5% / 1.28% | 9.4% / 0.74% | Dragging gamma onto alpha reorders the list to alpha, gamma, beta in both (C3 fixed in G3: the framer-motion shim drives Reorder from pointer moves with framer's one-neighbour-per-move rule). The dragged row does not follow the pointer in GPUIX, which has no transforms; the list reorders live under it. After the drop the web opens gamma, the dragged row, and paints alpha and gamma in their hover state (gear and Ctrl+1/Ctrl+2). GPUIX stays on alpha: D1 withholds the click that ends a drag. GPUIX paints alpha hovered, but its +4 -1 diff stat shows through the action strip's fade (bg-gradient-to-l from-[var(--rail-keycap)] from-60%), so Ctrl+1 is drawn over it. |
| `rail.add-menu` Add project menu and new project modal | rail | partial | ported | 5/5 | 5/5 | 77.8% / 1.33% |  | Clicking + opens the New project / New folder group menu and New project opens the Create New Project modal with the same fields in both. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| `rail.collapse` Collapse and expand the rail | rail | ported | ported | 3/3 | 3/3 | 6.4% / 0.98% |  | Collapsed rail matches: icons, project letters, Changes badge. The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `rail.project-settings` Project settings modal | rail | partial | ported | 5/5 | 5/5 | 31.0% / 0.73% |  | Clicking the gear opens Project settings with General and the same fields in both, with GPUIX automation and with real X input (--x11-input). The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. H1 fixed the lost gear click. GPUIX ends a hit test at the first absolutely placed or filled interactive box, and that box also blocks its own ancestors, so the row lost its hover as soon as its hover-revealed action strip painted under the pointer, hid the strip and the gear, and looped. The press landed on whichever frame was up. Compat now keeps an element hovered while a blocking box inside it is hovered (`src/compat/hover.ts`). `bun tools/clickloss/run.ts --trials 20` opens the modal 60/60 through automation and XTEST, against 27/60 on exp/gpuix-client at 9747b6c2. In the --x11-input frame the gear and its Project settings tooltip still paint above the modal. The automation frame has neither, and in clickloss traces the row, rail and gear get their leave once the scrim paints, so this is the hover settle catching up after the modal mounts (inferred). |
| `side.chats` Chats tab with a chat card | side-panel | ported | ported | 2/2 | 2/2 | 6.1% / 1.06% | 1.5% / 0.62% | The card title, agent, branch and age match; with more chats the cards stack one per row (G2 native ChatsList). |
| `side.chats-search` Search chats | side-panel | ported | ported | 7/7 | 7/7 | 6.1% / 1.10% |  | Filtering to no match and back matches, including the No matches. text. |
| `side.chat-card-menu` Chat card context menu | side-panel | ported | ported | 5/5 | 5/5 | 7.2% / 1.10% |  | Right-click on a chat card opens the same five-row menu with Delete Chat in red. |
| `side.workspace-switcher` Workspace (worktree) switcher | side-panel | ported | ported | 3/3 | 3/3 | 7.5% / 1.10% |  | The Working copies popover matches; GPUIX omits the small terminal glyph on the web row hover. |
| `side.hide` Hide and show the side panel | side-panel | ported | ported | 3/3 | 3/3 | 5.8% / 0.88% |  | Side panel hides; the expand chevron sits in the same place. |
| `explorer.tree` File tree | explorer | ported | ported | 6/6 | 6/6 | 6.2% / 1.06% |  | Tree, git colours and status letters match. |
| `explorer.expand` Expand a folder | explorer | ported | ported | 6/6 | 6/6 | 6.4% / 1.07% |  | Clicking src expands it to app.ts and utils.ts in both, with no tooltip over the row. The web frame also catches the row name hint that FileTreeNode shows after 900 ms of hover; the GPUIX frame is grabbed before it fires. |
| `explorer.context-menu` File context menu | explorer | ported | ported | 6/6 | 6/6 | 6.9% / 1.18% |  | Right-click on README.md opens the same file menu with Delete in red. |
| `explorer.drag` Drag a file from the tree into the pane to open it | explorer | ported | broken | 7/7 | 6/7 | 4.4% / 0.49% |  | Dragging notes.txt from the tree into the pane opens it in an editor tab in both (D1 compat drag and drop). |
| `editor.code` Code editor (CodeMirror) on a TypeScript file | editor | ported | broken | 6/6 | 5/6 | 4.3% / 0.78% |  | The native editor (E1) paints the same highlighted text, line numbers and active line; the text checks fail only because native text is painted inside GPUI and is not in the automation tree. |
| `editor.code-edit` Type into the code editor | editor | ported | broken | 9/9 | 7/9 | 4.1% / 0.75% |  | Click, End and typing put "// edited" on line 5 in both; the dirty dot shows on the tab. Same tree-text caveat as editor.code. |
| `editor.markdown` Markdown (BlockNote) editor | editor | partial | ported | 7/7 | 7/7 | 4.0% / 1.25% |  | Preview has the "On this page" outline (G4): the heading and paragraph rows land on the web rows (126, 195, 257 px), heading sizes follow BlockNote (48/32 px). List items sit 1 px off and the bullet is the native one; the heading has no -0.018em letter spacing (GPUIX has none), so "Alpha guide" is 10 px wider. The tab reads "guide.md" in full at the web width (C15 fixed in G5). A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. |
| `editor.tabs` Two editor tabs and switching | editor | ported | broken | 8/8 | 6/8 | 3.4% / 0.91% |  | Switching tabs works; the README preview matches the web, outline included. The tabs read README.md and app.ts in full at the web widths (C15 fixed in G5). The text check fails only because natively painted text is not in the automation tree. |
| `git.changes` Changes panel: staged, unstaged, untracked | git | ported | ported | 5/5 | 5/5 | 9.5% / 1.30% |  | Sections, rows, counts and history footer match, and the Amend last commit checkbox draws as the Chromium box (C5, G3). The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.amend` Amend last commit: the label and the box toggle it | git | ported | ported | 9/9 | 9/9 | 9.5% / 1.30% |  | Clicking the Amend last commit label checks the box and the button reads Amend commit with the last message filled in; clicking the box clears it, in both. The box, its check and its colours are sampled from Chromium. The web frames show the box in its hover colour because the pointer rests on it; GPUIX automation clicks without moving the pointer. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.diff` Diff view of an unstaged file | git | ported | ported | 5/5 | 5/5 | 57.8% / 1.31% |  | Inline diff, hunk header and STAGE HUNK match closely. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.stage` Stage a file | git | ported | ported | 5/5 | 5/5 | 9.5% / 1.30% |  | Staging README.md moves it to Staged 2 in both. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.unstage` Unstage a file | git | ported | ported | 5/5 | 5/5 | 10.0% / 1.28% |  | Unstaging app.ts moves it to Changes in both. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.discard` Discard a change (confirm dialog) | git | partial | ported | 5/5 | 5/5 | 86.5% / 1.85% |  | The confirm dialog matches. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| `git.commit` Commit staged changes | git | ported | ported | 7/7 | 7/7 | 11.5% / 1.81% |  | The commit lands (4 commits, bump version) in both. The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual. |
| `git.branch-picker` Branch picker | git | ported | ported | 3/3 | 3/3 | 7.4% / 1.29% |  | Branch popover, Local group, feature/login and Create branch row match. |
| `git.worktree-create` Working copies switcher: search or create a worktree | git | ported | ported | 5/5 | 5/5 | 7.6% / 1.06% |  | Typing a new name shows No matching working copies and Create worktree feat-matrix in both. |
| `chat.transcript` Open a chat: transcript, tool cards, changed files | chat | partial | broken | 5/5 | 4/5 | 15.9% / 2.28% | 19.4% / 3.97% | The transcript, code card, task list, Worked for row and Changed files bar all render. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. The text check fails only because natively painted text is not in the automation tree. |
| `chat.scroll-top` Transcript scrolled to the first turn | chat | partial | broken | 7/7 | 5/7 | 18.7% / 3.21% | 26.3% / 6.30% | One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. The text check fails only because natively painted text is not in the automation tree. |
| `chat.new-chat` New chat button | chat | ported | ported | 3/3 | 3/3 | 47.4% / 1.14% |  | New chat opens the launcher composer in place. |
| `chat.agent-launcher` Agent launcher menu | chat | partial | ported | 3/3 | 3/3 | 7.2% / 1.18% |  | The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. In GPUIX the chip stretches across the panel and the more button wraps to a second line. |
| `chat.send` Send a prompt from the dashboard and stream the reply | chat | partial | broken | 7/7 | 6/7 | 21.6% / 5.88% |  | Typing and Enter start a chat and the scripted reply streams in both. Mermaid shows as source ("Mermaid diagrams are shown as source in this client") where the web draws the diagram. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.model-selector` Model and mode selector in a running chat | chat | partial | partial | 4/4 | 4/4 | 15.9% / 2.28% |  | The running chat shows the agent chip and composer like the web. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. |
| `chat.plan` Plan panel from a plan update | chat | ported | broken | 10/10 | 9/10 | 25.5% / 1.80% |  | The pinned Plan panel and the inline plan card match: three entries, Medium chips, the struck-through finished entry and the 1/3 count. The short transcript starts at the top in both. The tab title reads in full at the web width (C15 fixed in G5). The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.permission` Permission prompt: allow a tool call | chat | ported | broken | 12/12 | 11/12 | 8.6% / 0.88% |  | The Approval needed card, its Allow and Reject buttons, the Needs you badge and the status-bar pill match; clicking Allow answers allow-once in both. The short transcript starts at the top in both. The tab title reads in full at the web width (C15 fixed in G5). The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.queue` Prompt queue while a turn runs | chat | partial | broken | 12/12 | 11/12 | 18.5% / 1.29% |  | A prompt sent while the turn runs shows under 1 Queued in both, and the stop button replaces send. Block spacing, list rhythm and the quote rule match, but native markdown paints links in the text colour (the web uses primary), inline code at body size (the web chip is smaller), no italics, and wraps a line holding inline code past the column edge. |
| `composer.mention` Mention menu (@) | composer | ported | ported | 4/4 | 4/4 | 7.2% / 1.62% |  | Both show "No files or folders match" for a bare @ on this server, so the file list itself is not compared here (tools/composer/e2e.ts covers it). The web draws a focus ring on the composer; GPUIX does not. |
| `composer.slash` Slash command menu (/) | composer | ported | ported | 4/4 | 4/4 | 9.9% / 1.67% |  | The Skills menu matches row for row. No focus ring on the GPUIX composer. |
| `composer.attach` Attach files button | composer | ported | ported | 2/2 | 2/2 | 8.7% / 1.60% |  | Clicking Attach files opens nothing visible in either client in this headless run (the web file chooser is a native dialog Playwright does not paint). |
| `terminal.open` Open a terminal from the status bar | terminal | partial | ported | 4/4 | 4/4 | 4.1% / 0.83% |  | Terminal tab, its full "Terminal 1" title at the web width, and the prompt match (C15 fixed in G5). The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. The status-bar Terminal button's title tooltip paints under the pointer after the click; the web frame shows none. |
| `terminal.type` Type a command and see its output | terminal | ported | ported | 5/5 | 5/5 | 3.2% / 0.95% |  | echo output matches cell for cell. |
| `terminal.vim-replies` Terminal query replies after vim (T1 fixture shape) | terminal | ported | ported | 8/8 | 8/8 | 4.2% / 1.49% |  | With the O1 fixture's command (vim -u NONE -N notes.txt, then :q!) typed into the full app, both clients return to a clean prompt; neither echoes ^[[>0;276;0c or rgb: replies. So the echo in O1's GPUIX shot does not reproduce in the full app with typed input: it belongs to the fixture, which writes its inputs to the PTY back to back, not to GPUIX (inferred; the fixture itself was not rerun here). |
| `terminal.file-link` Ctrl+click a file path in terminal output opens it in the editor | terminal | ported | broken | 8/8 | 7/8 | 4.3% / 0.99% |  | Ctrl+click on src/app.ts in terminal output opens app.ts in a new tab in both. The text check fails only because natively painted text is not in the automation tree. |
| `terminal.new-tab-menu` New tab menu (terminal, browser, ...) | terminal | ported | ported | 3/3 | 3/3 | 7.3% / 1.10% |  | The new tab menu matches. |
| `terminal.tab-reorder` Reorder terminal tabs by dragging | terminal | partial | broken | 10/10 | 9/10 | 2.9% / 0.71% |  | Pane tabs read "Terminal 1" in full at the web width (C15 fixed in G5). In GPUIX the click on Bash in the open New tab menu was lost in 2 of 2 G5 runs (before and after the C15 change), so no second terminal opened and nothing was reordered; terminal.split runs the same steps and opened it. |
| `terminal.split` Split panes: drag a second terminal tab to the pane edge | terminal | ported | ported | 12/12 | 12/12 | 3.1% / 0.99% |  | Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1), and each pane's tab shows its full title with its close button (C15 fixed in G5). |
| `statusbar.items` Status bar items | statusbar | ported | partial | 2/2 | 2/2 | 6.1% / 1.06% | 12.1% / 4.39% | Branch, path, Terminal and settings items line up. The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. The rest of the region diff is glyph antialiasing: Chromium draws the status bar text with subpixel (LCD) colour fringes, and GPUIX draws it in grayscale (C8). |
| `statusbar.context-bar` Context bar settings popover | statusbar | ported | ported | 3/3 | 3/3 | 7.2% / 1.30% |  | The Show in Context Bar popover opens with the same five toggles and states. |
| `statusbar.connection` Connection indicator hover | statusbar | ported | ported | 3/3 | 3/3 | 6.7% / 1.12% |  | Hovering the connection lamp shows the Connected tooltip in both. The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `remote.access-popover` Remote access popover (desktop shared-live host) | remote | blocked | blocked | n/a | n/a |  |  | Not compared: the popover renders only under isTauriContext(), so the web client has no reference. |
| `settings.interface` Settings: Interface | settings | partial | ported | 5/5 | 5/5 | 31.8% / 1.22% | 4.2% / 1.43% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `settings.notifications` Settings: Notifications | settings | partial | ported | 5/5 | 5/5 | 33.9% / 1.51% | 7.3% / 1.86% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. Row dividers inside a group are missing and rows sit tighter. |
| `settings.editor` Settings: Editor | settings | partial | ported | 5/5 | 5/5 | 32.3% / 1.04% | 4.9% / 1.17% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `settings.appearance` Settings: Appearance | settings | partial | partial | 5/5 | 5/5 | 39.2% / 2.50% | 15.0% / 3.30% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. Renderer and Scrollback descriptions now wrap normally beside the closed select. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `settings.shell` Settings: Shell | settings | partial | ported | 5/5 | 5/5 | 31.1% / 0.84% | 3.1% / 0.87% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `settings.terminal-profiles` Settings: Profiles | settings | partial | ported | 5/5 | 5/5 | 31.2% / 0.95% | 3.3% / 1.03% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `settings.ai-agents` Settings: Agent chats | settings | partial | partial | 5/5 | 5/5 | 40.7% / 2.65% | 17.2% / 3.53% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The agents list shows No agents match while the web lists the registry. The rows lay out beside their selects once the settings card has measured itself; on a loaded host the frame can be grabbed before that (the first frame lays container queries out narrow), so the Close idle chats after row shows stacked with a full-width select in some runs (2 of 3 in G5). |
| `settings.skills` Settings: Skills | settings | partial | partial | 5/5 | 5/5 | 35.9% / 2.33% | 10.2% / 3.06% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `settings.provider` Settings: Accounts | settings | partial | ported | 5/5 | 5/5 | 32.3% / 0.96% | 4.9% / 1.05% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. The usage line moves under the account instead of beside it. |
| `settings.mcp-servers` Settings: MCP servers | settings | partial | partial | 5/5 | 5/5 | 35.3% / 1.82% | 9.4% / 2.30% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. The inline code in the footnote breaks onto its own line. |
| `settings.shortcuts` Settings: Keyboard shortcuts | settings | partial | partial | 5/5 | 5/5 | 34.8% / 2.00% | 8.6% / 2.57% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `settings.diagnostics` Settings: Logs | settings | partial | partial | 5/5 | 5/5 | 35.5% / 1.80% | 9.6% / 2.27% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. Server version reads termul-server v0.4.52 in both: GPUIX asks the server (G4). |
| `settings.reset` Settings: Reset | settings | partial | ported | 5/5 | 5/5 | 31.2% / 1.12% | 3.3% / 1.27% | The section content and navigation match. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `palette.open` Command palette (Ctrl+K) and filtering | palette | ported | ported | 9/9 | 9/9 | 6.1% / 1.06% |  |  |
| `palette.type-ahead` Typing straight after Ctrl+K reaches the palette filter | palette | partial | broken | 5/5 | 4/5 | 75.3% / 1.63% |  | Typing "theme" straight after Ctrl+K filters the palette in both, and the rows rank the same (C16 fixed in G3: the cmdk shim scores with cmdk's command-score and sorts as cmdk does), Open Canvas first under Workspace. The step races in both clients: in some runs the web drops the first key ("heme") and in some GPUIX does (an empty filter); GPUIX failed this check in 5 of 9 G3 runs, 3 of 6 with the C16 change and 2 of 3 without it. The search field shows its focus underline as on the web (G5: the matrix makes the GPUIX window the active X window, as the Playwright page is focused; an inactive GPUI window gets no focus events). |
| `palette.new-terminal` Palette command: New Terminal | palette | ported | ported | 8/8 | 8/8 | 3.7% / 1.28% |  | New Terminal opens Terminal 1 in both. |
| `palette.agent-launcher` Palette command: Agent Launcher | palette | ported | ported | 9/9 | 9/9 | 48.6% / 1.75% |  | Agent Launcher shows the launcher with its close button in both. |
| `palette.save-snapshot` Palette command: Save Workspace Snapshot | snapshots | partial | ported | 9/9 | 9/9 | 83.2% / 1.34% |  | The Create Snapshot modal matches. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| `palette.open-canvas` Palette command: Open Canvas | palette | blocked | partial | 9/9 | 9/9 | 5.7% / 2.92% |  | Opens the canvas tab in both; see canvas.open for why the canvas itself is not compared. |
| `palette.project-settings` Palette command: Project Settings | palette | partial | ported | 9/9 | 9/9 | 30.8% / 0.85% |  | Project settings opens on General with the same fields. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| `palette.app-preferences` Palette command: App Preferences | palette | partial | ported | 9/9 | 9/9 | 32.0% / 1.37% |  | Preferences opens on Interface. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| `palette.switch-project` Palette command: beta | rail | ported | ported | 9/9 | 9/9 | 5.6% / 0.93% |  | Typing beta filters to the beta row and Enter switches to beta in both. |
| `palette.command-history` Palette command: Command History | palette | partial | ported | 9/9 | 9/9 | 81.5% / 1.33% |  | The Command History modal, its scope picker and empty state match. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. The search field shows its focus ring as on the web (G5). |
| `palette.color-theme` Palette command: Change Color Theme | palette | ported | ported | 9/9 | 9/9 | 19.5% / 1.51% |  | Change Color Theme opens the Color Themes popover in both; see theme.picker for its tint. |
| `palette.shortcut-menu` Palette command: Open Shortcut Menu | palette | partial | ported | 9/9 | 9/9 | 78.3% / 1.79% |  | Opens the Shortcut Menu in both. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| `palette.report-bug` Palette command: Report a Bug | palette | partial | ported | 9/9 | 9/9 | 59.7% / 1.04% |  | Opens the Report a bug dialog, laid out as in dialogs.bug-report. |
| `shortcuts.menu` Keyboard shortcuts popover | shortcuts | partial | ported | 3/3 | 3/3 | 76.8% / 1.57% |  | Shortcut Menu rows, descriptions and key chips match, including the blank Command History chip in both. The scrim has the web dim and colour (a flat patch reads 4,5,6 on the web and 5,5,6 in GPUIX), but GPUIX has no backdrop blur, so the page behind stays sharp and readable. |
| `shortcuts.settings-shortcut` Settings shortcut (web Alt+,, desktop Ctrl+,); Escape closes the dialog | shortcuts | ported | ported | 6/6 | 6/6 | 6.1% / 1.06% |  | Each client presses its own key (G3): Alt+, on the web and the desktop Ctrl+, in GPUIX (G4 keymap) open Preferences, and Escape closes it in both. |
| `shortcuts.toggle-projects` Default shortcut ctrl-shift-b: collapse the project rail | shortcuts | ported | ported | 5/5 | 5/5 | 6.4% / 0.94% |  | Ctrl+Shift+B collapses the rail in both. |
| `shortcuts.toggle-side-panel` Default shortcut ctrl-b: hide the side panel | shortcuts | ported | ported | 5/5 | 5/5 | 5.7% / 0.83% |  | Ctrl+B hides the side panel in both. |
| `shortcuts.theme-picker` Default shortcut ctrl-alt-t: theme picker | shortcuts | ported | ported | 5/5 | 5/5 | 16.1% / 1.23% |  | Ctrl+Alt+T opens the Color Themes popover in both. |
| `shortcuts.zoom-in` Default shortcut alt-=: zoom in | shortcuts | partial | partial | 5/5 | 5/5 | 15.0% / 2.33% |  | Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4's keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both). The zoomed web page runs past the window bottom, so its status bar is cut off and the dashboard heading sits 25 px lower; GPUIX keeps the status bar in the window. |
| `shortcuts.desktop-keymap` Desktop key bindings (Ctrl+T, Ctrl+W, Ctrl+R, Ctrl+, and Ctrl+=) | shortcuts | blocked | blocked | n/a | n/a |  |  | No web reference. GPUIX registers a desktop host, which now gets the same Ctrl-based keymap as Tauri (G4): workspace-checks asserts Ctrl+, opens Preferences, Ctrl+R opens command history and Alt+, does nothing. |
| `theme.picker` Theme picker | theme | ported | ported | 4/4 | 4/4 | 16.2% / 1.24% |  | The Color Themes popover, groups, swatches and the current-theme check match, and labels antialias in grayscale as on the web (C8 fixed in G3). The search field shows its focus ring as on the web (G5: the matrix makes the GPUIX window the active X window, as the Playwright page is focused; an inactive GPUI window gets no focus events). |
| `dialogs.bug-report` Report a bug dialog | dialogs | partial | ported | 3/3 | 3/3 | 59.5% / 0.83% |  | The Report a bug dialog paints its Title, What happened, Screenshots and Preview sections at the web width and wraps the same lines. The Title field opens focused with its ring in both (G5: the matrix makes the GPUIX window the active X window, as the Playwright page is focused; an inactive GPUI window gets no focus events). The web draws a resize grip in the What happened corner; GPUIX has none. The scrim has the web dim and colour, but GPUIX has no backdrop blur, so the page behind stays sharp. |
| `canvas.open` Canvas | canvas | blocked | partial | 4/4 | 4/4 | 4.9% / 2.45% |  | This server build ships no figcraft bundle, so the web tab shows the BUNDLE_MISSING error JSON; GPUIX stays on Loading editor... and paints neither that error nor an editor. The canvas is a figcraft iframe (CanvasMountLayer), which GPUIX 0.11 cannot host. |
| `browser.pane` Browser pane | browser | blocked | blocked | n/a | n/a |  |  | Not compared: browser tabs are Tauri webviews with no web-client reference, and GPUIX 0.11 has no webview element. Replacing Tauri loses the browser pane until a native webview exists. |
| `notifications.toast` Toast after creating a branch | notifications | ported | ported | 7/7 | 7/7 | 7.1% / 1.39% |  | Typing the branch name and pressing Enter creates toast-branch and shows the success toast in both. The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual. |
| `ssh.workspace` SSH profiles and sessions | ssh | blocked | pending-unit | n/a | n/a |  |  | No web reference: SSH needs a host-local client and a browser never is one, so the web client shows no SSH section. R2 drove the GPUIX real shell as a host-local client against a throwaway sshd (reports/r2-shots): the sidebar SSH section, the hosts tab, host-key trust, a connected shell and the SFTP file list all render. The SFTP Modified column wrapped times such as 12:26 AM onto two lines in gpuix-ssh-connected.png, and Chromium wraps them too: the tabular-figure time is 57 px in a w-14 (56 px) column. G3 widened the shared column to w-16 in SftpEntryRow, a web fix (C14). |
| `settings.accounts-claude` Claude account sign-in | settings | blocked | pending-unit | n/a | n/a |  |  | No web reference: Claude account management needs a host-local client. The R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path; no GPUIX pixel check of the sign-in flow exists yet. |
| `update.toast` Update available toast and what's new modal | notifications | blocked | blocked | n/a | n/a |  |  | Not compared: the update toast and the what's new modal render only under isTauriContext(), so neither client shows them (the web hides them by design). GPUIX shows its version like the web (Preferences, Logs: termul-server v0.4.52). A GPUIX update check against the release feed is not built yet. |
| `snapshots.page` Snapshots page (#/snapshots) | snapshots | blocked | blocked | n/a | n/a |  |  |  |
| `theme.termul-dark` Theme termul (dark) | theme | ported | ported | 2/2 | 2/2 | 6.1% / 1.07% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.termul-light` Theme termul (light) | theme | ported | ported | 2/2 | 2/2 | 4.4% / 1.34% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.cursor-dark` Theme cursor (dark) | theme | ported | ported | 2/2 | 2/2 | 3.9% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.cursor-light` Theme cursor (light) | theme | ported | ported | 2/2 | 2/2 | 4.4% / 1.32% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.catppuccin-dark` Theme catppuccin (dark) | theme | ported | ported | 2/2 | 2/2 | 6.5% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.catppuccin-light` Theme catppuccin (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.dracula-dark` Theme dracula (dark) | theme | ported | ported | 2/2 | 2/2 | 4.3% / 1.26% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.dracula-light` Theme dracula (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.29% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.nord-dark` Theme nord (dark) | theme | ported | ported | 2/2 | 2/2 | 4.3% / 1.27% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.nord-light` Theme nord (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.27% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.gruvbox-dark` Theme gruvbox (dark) | theme | ported | ported | 2/2 | 2/2 | 6.5% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.gruvbox-light` Theme gruvbox (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.26% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.tokyonight-dark` Theme tokyonight (dark) | theme | ported | ported | 2/2 | 2/2 | 6.5% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.tokyonight-light` Theme tokyonight (light) | theme | ported | ported | 2/2 | 2/2 | 4.4% / 1.07% |  | Colours match the web dashboard. In the first full run this GPUIX launch crashed to "Uncaught runtime errors: Timed out after 2 seconds waiting for the automation bounds query" (compat live-reads from a tanstack-virtual resize); the rerun booted cleanly, so the crash is intermittent. |
| `theme.ayu-dark` Theme ayu (dark) | theme | ported | ported | 2/2 | 2/2 | 4.4% / 1.23% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.ayu-light` Theme ayu (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.27% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.one-dark-dark` Theme one-dark (dark) | theme | ported | ported | 2/2 | 2/2 | 6.5% / 1.22% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.one-dark-light` Theme one-dark (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.29% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.github-dark` Theme github (dark) | theme | ported | ported | 2/2 | 2/2 | 6.1% / 1.23% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.github-light` Theme github (light) | theme | ported | ported | 2/2 | 2/2 | 4.5% / 1.35% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |

### Driven interactions and literal results

- `rail.project-list` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/rail-project-list/`):
  - `a-dashboard`: present "alpha": web pass, gpuix pass; present "beta": web pass, gpuix pass; present "gamma": web pass, gpuix pass; present "delta": web pass, gpuix pass; present "What should we do in alpha?": web pass, gpuix pass
  - `b-switch-beta`: click #project-item-m1-beta (web ok; gpuix ok via testid); present "What should we do in beta?": web pass, gpuix pass
- `rail.project-menu` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/rail-project-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: right-click #project-item-m1-beta (web ok; gpuix ok via testid); present "Rename": web pass, gpuix pass
- `rail.project-rename` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/rail-project-rename/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-rename`: right-click #project-item-m1-gamma (web ok; gpuix ok via testid); click "Rename" (web ok; gpuix ok via text); click [data-testid="shell-rail"] input (web ok; gpuix ok via web-point); press ctrl-a (web ok; gpuix ok via key); type "gamma-renamed" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); present "gamma-renamed": web pass, gpuix pass
- `rail.project-remove` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/rail-project-remove/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-confirm`: right-click #project-item-m1-delta (web ok; gpuix ok via testid); click "Delete" (web ok; gpuix ok via text); present "Delete Project": web pass, gpuix pass
  - `c-removed`: click [Delete] (web ok; gpuix ok via web-point); gone "delta": web pass, gpuix pass
- `rail.project-colour` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/rail-project-colour/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: right-click #project-item-m1-beta (web ok; gpuix ok via testid); click "Change Color" (web ok; gpuix ok via text); present "Select Color": web pass, gpuix pass
- `rail.project-reorder` (frames `/root/termul-wt/gpuix-h1/apps/gpuix/parity-out/matrix/rail-project-reorder/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-dragged`: drag #project-item-m1-gamma -> #project-item-m1-alpha (web ok; gpuix ok via testid); wait 500 ms (web ok; gpuix ok via none); present "alpha < gamma < beta": web pass, gpuix pass
- `rail.add-menu` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/rail-add-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [Add project or folder group] (web ok; gpuix ok via web-point); present "New project": web pass, gpuix pass
  - `c-modal`: click "New project" (web ok; gpuix ok via text); present "Create": web pass, gpuix pass
- `rail.collapse` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-collapse/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-collapsed`: click [Expand or collapse projects] (web ok; gpuix ok via web-point); gone "Projects": web pass, gpuix pass
- `rail.project-settings` (frames `/root/termul-wt/gpuix-h1/apps/gpuix/parity-out/matrix/rail-project-settings/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-beta`: click #project-item-m1-beta (web ok; gpuix ok via testid); present "What should we do in beta?": web pass, gpuix pass
  - `c-settings`: click [Settings for beta] (web ok; gpuix ok via web-point); present "Basic project identification and location.": web pass, gpuix pass
- `side.chats` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/side-chats/`):
  - `a-chats`: present "How does the web client decide which routes rend": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass
- `side.chats-search` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/side-chats-search/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-miss`: click input[placeholder^="Search chats"] (web ok; gpuix ok via web-point); type "zzz-no-match" (web ok; gpuix ok via key); gone "How does the web client decide which routes rend": web pass, gpuix pass
  - `c-hit`: press ctrl-a (web ok; gpuix ok via key); type "routes" (web ok; gpuix ok via key); present "How does the web client decide which routes rend": web pass, gpuix pass
- `side.chat-card-menu` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/side-chat-card-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: right-click "How does the web client decide which routes rend" (web ok; gpuix ok via text); present "Open in split": web pass, gpuix pass; present "Copy Path": web pass, gpuix pass; present "Delete Chat": web pass, gpuix pass
- `side.workspace-switcher` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/side-workspace-switcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Workspace] (web ok; gpuix ok via web-point); present "Current checkout": web pass, gpuix pass
- `side.hide` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/side-hide/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-hidden`: click [Hide side panel] (web ok; gpuix ok via web-point); gone "How does the web client decide which routes rend": web pass, gpuix pass
- `explorer.tree` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/explorer-tree/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "src": web pass, gpuix pass; present "docs": web pass, gpuix pass; present "README.md": web pass, gpuix pass; present "notes.txt": web pass, gpuix pass
- `explorer.expand` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/explorer-expand/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "src": web pass, gpuix pass
  - `c-expanded`: click "src" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass; present "utils.ts": web pass, gpuix pass
- `explorer.context-menu` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/explorer-context-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-menu`: right-click "README.md" (web ok; gpuix ok via text); present "Rename": web pass, gpuix pass; present "Delete": web pass, gpuix pass
- `explorer.drag` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/explorer-drag/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "notes.txt": web pass, gpuix pass; present "docs": web pass, gpuix pass
  - `c-dropped`: drag "notes.txt" -> [data-pane-content] (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "untracked notes": web pass, gpuix FAIL
- `editor.code` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/editor-code/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-open`: click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
- `editor.code-edit` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/editor-code-edit/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "Explorer" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
  - `c-typed`: click "VERSION" (web ok; gpuix ok via web-point); press end (web ok; gpuix ok via key); type " // edited" (web ok; gpuix ok via key); present "// edited": web pass, gpuix FAIL
- `editor.markdown` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/editor-markdown/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); click "docs" (web ok; gpuix ok via text); present "guide.md": web pass, gpuix pass
  - `c-open`: click "guide.md" (web ok; gpuix ok via text); present "Alpha guide": web pass, gpuix pass; present "Setup": web pass, gpuix pass
- `editor.tabs` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/editor-tabs/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click "Explorer" (web ok; gpuix ok via text); click "README.md" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
  - `c-back`: click [role="tab"]:has-text("README.md") (web ok; gpuix ok via web-point); present "The matrix project.": web pass, gpuix FAIL
- `git.changes` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/git-changes/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass; present "README.md": web pass, gpuix pass; present "notes.txt": web pass, gpuix pass
- `git.amend` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/git-amend/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "Amend last commit": web pass, gpuix pass
  - `c-label`: click "Amend last commit" (web ok; gpuix ok via text); wait 400 ms (web ok; gpuix ok via none); present "Amend commit": web pass, gpuix pass
  - `d-box`: click input[type="checkbox"] (web ok; gpuix ok via web-point); wait 400 ms (web ok; gpuix ok via none); gone "Amend commit": web pass, gpuix pass
- `git.diff` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/git-diff/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-diff`: click "README.md" (web ok; gpuix ok via text); present "An unstaged line.": web pass, gpuix pass
- `git.stage` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/git-stage/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-staged`: click [Stage changes] (web ok; gpuix ok via web-point); present "README.md": web pass, gpuix pass
- `git.unstage` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/git-unstage/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-unstaged`: click [Unstage changes] (web ok; gpuix ok via web-point); present "app.ts": web pass, gpuix pass
- `git.discard` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/git-discard/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-confirm`: click [Discard changes] (web ok; gpuix ok via web-point); present "Discard": web pass, gpuix pass
- `git.commit` (frames `/root/termul-wt/gpuix-g4/apps/gpuix/parity-out/matrix/git-commit/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-message`: click input[placeholder="Summary (required)"] (web ok; gpuix ok via web-point); type "bump version" (web ok; gpuix ok via key)
  - `d-committed`: click [Commit to main] (web ok; gpuix ok via web-point); gone "app.ts": web pass, gpuix pass
- `git.branch-picker` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/git-branch-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: click [Switch git branch] (web ok; gpuix ok via web-point); present "feature/login": web pass, gpuix pass
- `git.worktree-create` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-worktree-create/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-switcher`: click [Workspace] (web ok; gpuix ok via web-point); present "main": web pass, gpuix pass
  - `c-typed`: type "feat-matrix" (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none)
- `chat.transcript` (frames `/root/termul-wt/gpuix-g2/apps/gpuix/parity-out/matrix/chat-transcript/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "One more place parses it": web pass, gpuix FAIL; present "Changed files": web pass, gpuix pass
- `chat.scroll-top` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/chat-scroll-top/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "One more place parses it": web pass, gpuix FAIL
  - `c-top`: wheel -20000 over "One more place parses it" (web ok; gpuix ok via web-point); wait 1200 ms (web ok; gpuix ok via none); present "Three call sites depend on it": web pass, gpuix FAIL
- `chat.new-chat` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-new-chat/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-new`: click [New chat] (web ok; gpuix ok via web-point); present "Chat Scenario Agent": web pass, gpuix pass
- `chat.agent-launcher` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/chat-agent-launcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click button[aria-label^="Agent and model"] (web ok; gpuix ok via web-point); present "This agent gives no model": web pass, gpuix pass
- `chat.send` (frames `/root/termul-wt/gpuix-g2/apps/gpuix/parity-out/matrix/chat-send/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-typed`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "Explain the router" (web ok; gpuix ok via key); present "Explain the router": web pass, gpuix pass
  - `c-reply`: press enter (web ok; gpuix ok via key); wait 4000 ms (web ok; gpuix ok via none); present "The router docs cover the hash variant in more depth": web pass, gpuix FAIL
- `chat.model-selector` (frames `/root/termul-wt/gpuix-g2/apps/gpuix/parity-out/matrix/chat-model-selector/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1000 ms (web ok; gpuix ok via none); present "Chat Scenario Agent": web pass, gpuix pass
- `chat.plan` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/chat-plan/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-reply`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix plan" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 3000 ms (web ok; gpuix ok via none); present "Here is the plan for the router work.": web pass, gpuix FAIL
  - `c-panel`: present "Plan": web pass, gpuix pass; present "Read the router module": web pass, gpuix pass; present "Write the hash router tests": web pass, gpuix pass; present "Update the router docs": web pass, gpuix pass
- `chat.permission` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/chat-permission/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-prompt`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix permission" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 3000 ms (web ok; gpuix ok via none); present "Run the router test suite": web pass, gpuix pass; present "Allow": web pass, gpuix pass; present "Reject": web pass, gpuix pass
  - `c-allowed`: click "Allow" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "Permission answer: allow-once": web pass, gpuix FAIL; gone "Reject": web pass, gpuix pass
- `chat.queue` (frames `/root/termul-wt/gpuix-g2/apps/gpuix/parity-out/matrix/chat-queue/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-holding`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix hold" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 2500 ms (web ok; gpuix ok via none); present "Holding this turn open for the queue.": web pass, gpuix FAIL
  - `c-queued`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "queued follow-up" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 1200 ms (web ok; gpuix ok via none); present "Queued": web pass, gpuix pass; present "queued follow-up": web pass, gpuix pass
- `composer.mention` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/composer-mention/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "@" (web ok; gpuix ok via key); present "No files or folders match": web pass, gpuix pass
- `composer.slash` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/composer-slash/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "/" (web ok; gpuix ok via key); present "Skills": web pass, gpuix pass
- `composer.attach` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/composer-attach/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-click`: click [Attach files] (web ok; gpuix ok via web-point)
- `terminal.open` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/terminal-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none); present "Terminal": web pass, gpuix pass
- `terminal.type` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/terminal-type/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-echo`: type "echo matrix-$((6*7)) " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
- `terminal.vim-replies` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/terminal-vim-replies/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-vim`: type "vim -u NONE -N notes.txt " (web ok; gpuix ok via key); wait 2500 ms (web ok; gpuix ok via none)
  - `d-quit`: press escape (web ok; gpuix ok via key); type ":q! " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
- `terminal.file-link` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/terminal-file-link/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-echo`: type "clear && echo src/app.ts " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
  - `d-link`: ctrl-click .xterm-screen (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none); present "export function greet": web pass, gpuix FAIL
- `terminal.new-tab-menu` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/terminal-new-tab-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [New tab] (web ok; gpuix ok via web-point); present "Terminal": web pass, gpuix pass
- `terminal.tab-reorder` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/terminal-tab-reorder/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); click [New tab] (web ok; gpuix ok via web-point); click [Bash] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix FAIL
  - `c-reordered`: drag "Terminal 2" -> [role="tab"]:has-text("Terminal 1") (web ok; gpuix ok via web-point); wait 1200 ms (web ok; gpuix ok via none)
- `terminal.split` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/terminal-split/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); click [New tab] (web ok; gpuix ok via web-point); click [Bash] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
  - `c-split`: drag "Terminal 2" -> [data-pane-content] (web ok; gpuix ok via text); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
- `statusbar.items` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/statusbar-items/`):
  - `a-dashboard`: present "main": web pass, gpuix pass; present "Terminal": web pass, gpuix pass
- `statusbar.context-bar` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/statusbar-context-bar/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-popover`: click [Context bar settings] (web ok; gpuix ok via web-point); present "Branch": web pass, gpuix pass
- `statusbar.connection` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/statusbar-connection/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-hover`: hover [Connected] (web ok; gpuix ok via web-point); wait 1200 ms (web ok; gpuix ok via none)
- `remote.access-popover`: StatusBar renders RemoteAccessPopover only under isTauriContext(); the web client has none to compare, and GPUIX would need the desktop host role from the server
- `settings.interface` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/settings-interface/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Interface" (web ok; gpuix ok via text); present "Interface zoom": web pass, gpuix pass
- `settings.notifications` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/settings-notifications/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Notifications" (web ok; gpuix ok via text); present "Notify when a terminal agent finishes": web pass, gpuix pass
- `settings.editor` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/settings-editor/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Editor" (web ok; gpuix ok via text); present "Auto save delay": web pass, gpuix pass
- `settings.appearance` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/settings-appearance/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Appearance" (web ok; gpuix ok via text); present "Font size": web pass, gpuix pass
- `settings.shell` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/settings-shell/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Shell" (web ok; gpuix ok via text); present "Default shell": web pass, gpuix pass
- `settings.terminal-profiles` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-terminal-profiles/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Profiles" (web ok; gpuix ok via text); present "No terminal profiles": web pass, gpuix pass
- `settings.ai-agents` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/settings-ai-agents/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Agent chats" (web ok; gpuix ok via text); present "Close idle chats after": web pass, gpuix pass
- `settings.skills` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-skills/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Skills" (web ok; gpuix ok via text); present "Skills": web pass, gpuix pass
- `settings.provider` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/settings-provider/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Accounts" (web ok; gpuix ok via text); present "Accounts": web pass, gpuix pass
- `settings.mcp-servers` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-mcp-servers/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "MCP servers" (web ok; gpuix ok via text); present "MCP servers": web pass, gpuix pass
- `settings.shortcuts` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-shortcuts/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Keyboard shortcuts" (web ok; gpuix ok via text); present "Command Palette": web pass, gpuix pass
- `settings.diagnostics` (frames `/root/termul-wt/gpuix-g4/apps/gpuix/parity-out/matrix/settings-diagnostics/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Logs" (web ok; gpuix ok via text); present "Application log": web pass, gpuix pass
- `settings.reset` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-reset/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Reset" (web ok; gpuix ok via text); present "Reset all settings": web pass, gpuix pass
- `palette.open` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/palette-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: press ctrl-k (web ok; gpuix ok via key); present "App Preferences": web pass, gpuix pass; present "New Terminal": web pass, gpuix pass
  - `c-filter`: type "theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `d-escape`: press escape (web ok; gpuix ok via key); gone "Change Color Theme": web pass, gpuix pass
- `palette.type-ahead` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/palette-type-ahead/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-typed`: press ctrl-k (web ok; gpuix ok via key); type "theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix FAIL
- `palette.new-terminal` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-new-terminal/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "New Terminal" (web ok; gpuix ok via key); present "New Terminal": web pass, gpuix pass
  - `c-run`: click "New Terminal" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Terminal": web pass, gpuix pass
- `palette.agent-launcher` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-agent-launcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Agent Launcher" (web ok; gpuix ok via key); present "Agent Launcher": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Agent Launcher" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Chat Scenario Agent": web pass, gpuix pass
- `palette.save-snapshot` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/palette-save-snapshot/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Save Workspace Snapshot" (web ok; gpuix ok via key); present "Save Workspace Snapshot": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Save Workspace Snapshot" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Snapshot": web pass, gpuix pass
- `palette.open-canvas` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-open-canvas/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Open Canvas" (web ok; gpuix ok via key); present "Open Canvas": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Open Canvas" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Canvas": web pass, gpuix pass
- `palette.project-settings` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/palette-project-settings/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Project Settings" (web ok; gpuix ok via key); present "Project Settings": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Project Settings" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Basic project identification and location.": web pass, gpuix pass
- `palette.app-preferences` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/palette-app-preferences/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "App Preferences" (web ok; gpuix ok via key); present "App Preferences": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "App Preferences" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Interface zoom": web pass, gpuix pass
- `palette.switch-project` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/palette-switch-project/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "beta" (web ok; gpuix ok via key); present "beta": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: press enter (web ok; gpuix ok via key); wait 1200 ms (web ok; gpuix ok via none); present "What should we do in beta?": web pass, gpuix pass
- `palette.command-history` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/palette-command-history/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Command History" (web ok; gpuix ok via key); present "Command History": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Command History" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Command History": web pass, gpuix pass
- `palette.color-theme` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/palette-color-theme/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Change Color Theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Change Color Theme" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Dracula": web pass, gpuix pass
- `palette.shortcut-menu` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-shortcut-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Open Shortcut Menu" (web ok; gpuix ok via key); present "Open Shortcut Menu": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Open Shortcut Menu" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Shortcut Menu": web pass, gpuix pass
- `palette.report-bug` (frames `/root/termul-wt/gpuix-g1/apps/gpuix/parity-out/matrix/palette-report-bug/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Report a Bug" (web ok; gpuix ok via key); present "Report a Bug": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Report a Bug" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Report a bug": web pass, gpuix pass
- `shortcuts.menu` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/shortcuts-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Open keyboard shortcuts menu] (web ok; gpuix ok via web-point); present "Shortcut Menu": web pass, gpuix pass
- `shortcuts.settings-shortcut` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/shortcuts-settings-shortcut/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: press alt-, (GPUIX ctrl-,) (web ok; gpuix ok via key); present "Interface zoom": web pass, gpuix pass
  - `c-escape`: press escape (web ok; gpuix ok via key); wait 600 ms (web ok; gpuix ok via none); gone "Interface zoom": web pass, gpuix pass
- `shortcuts.toggle-projects` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/shortcuts-toggle-projects/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-shift-b (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "gamma": web pass, gpuix pass
- `shortcuts.toggle-side-panel` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/shortcuts-toggle-side-panel/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-b (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "Explorer": web pass, gpuix pass
- `shortcuts.theme-picker` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/shortcuts-theme-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-alt-t (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "Color Themes": web pass, gpuix pass
- `shortcuts.zoom-in` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/shortcuts-zoom-in/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press alt-= (GPUIX ctrl-=) (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `shortcuts.desktop-keymap`: No web reference: the web client swaps browser-reserved keys for Alt combos, and GPUIX inherits that keymap because it is not a Tauri context
- `theme.picker` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/theme-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Color themes] (web ok; gpuix ok via web-point); present "Dracula": web pass, gpuix pass; present "Nord": web pass, gpuix pass
- `dialogs.bug-report` (frames `/root/termul-wt/gpuix-g5/apps/gpuix/parity-out/matrix/dialogs-bug-report/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Report a bug] (web ok; gpuix ok via web-point); present "Report a bug": web pass, gpuix pass
- `canvas.open` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/canvas-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Open canvas] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); present "Canvas": web pass, gpuix pass
- `browser.pane`: Browser tabs are Tauri native webviews; the web client offers no New Browser Tab, so there is no reference, and GPUIX 0.11 has no webview element
- `notifications.toast` (frames `/root/termul-wt/gpuix-g4/apps/gpuix/parity-out/matrix/notifications-toast/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: click [Switch git branch] (web ok; gpuix ok via web-point); click "Create branch from" (web ok; gpuix ok via text)
  - `c-toast`: type "toast-branch" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); present "Created and checked out toast-branch": web pass, gpuix pass
- `ssh.workspace`: No web reference: SSH needs a host-local client (useHostGate(canUseHostSsh)), which a browser never is; R2 drove the GPUIX flow against a throwaway sshd (reports/r2-shots)
- `settings.accounts-claude`: No web reference: Claude account management needs a host-local client, which a browser never is; the R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path
- `update.toast`: Both render only when isTauriContext() is true (App.tsx WhatsNewModal, UpdateAvailableToast); the web client never shows them, so there is no reference to compare against
- `snapshots.page`: The desktop shell has no link to the route; only the mobile drawer navigates to it, and GPUIX cannot start on a hash route yet
- `theme.termul-dark` (frames `/root/termul-wt/gpuix-g3/apps/gpuix/parity-out/matrix/theme-termul-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.termul-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-termul-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.cursor-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-cursor-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.cursor-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-cursor-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.catppuccin-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-catppuccin-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.catppuccin-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-catppuccin-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.dracula-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-dracula-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.dracula-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-dracula-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.nord-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-nord-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.nord-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-nord-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.gruvbox-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-gruvbox-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.gruvbox-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-gruvbox-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.tokyonight-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-tokyonight-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.tokyonight-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-tokyonight-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.ayu-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-ayu-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.ayu-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-ayu-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.one-dark-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-one-dark-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.one-dark-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-one-dark-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.github-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-github-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.github-light` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-github-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass

<!-- matrix:end -->
