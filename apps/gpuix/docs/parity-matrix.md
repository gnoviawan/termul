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
bun run parity:matrix                    # every surface, about 40 minutes
bun run parity:matrix --only git.diff,chat.send
bun run parity:matrix --area terminal
bun run parity:matrix --report-only      # regenerate this page from results.json and review.ts
bun tools/matrix/probe.ts <surface-id>   # web only: what the DOM offers to act on, per step
bun tools/matrix/pair.ts [surface-id]    # web | GPUIX side by side, for review
```

Output goes to `parity-out/matrix/<surface>/<step>/` (`web.png`, `gpuix.png`,
`diff.png`, the region crops and `pair.png`) and `parity-out/matrix/results.json`.
A partial run updates only the surfaces it ran. Server and client state live
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

<!-- matrix:begin (generated by `bun run parity:matrix`; edit tools/matrix/review.ts, not this block) -->

Surfaces: 115 (ported 46, partial 38, broken 22, blocked 9, unverified 0, pending-unit 0).

| Score | All surfaces (pending, blocked and unverified count 0) | Measured surfaces only |
| --- | ---: | ---: |
| Unweighted | 56.5% | 61.3% |
| Usage-weighted | 59.7% | 61.7% |

### By area

| Area | Weight | Surfaces | Ported | Partial | Broken | Blocked, pending or unverified | Area score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chat | 17 | 9 | 1 | 6 | 2 | 0 | 44.4% |
| composer | 14 | 3 | 3 | 0 | 0 | 0 | 100.0% |
| terminal | 14 | 7 | 4 | 3 | 0 | 0 | 78.6% |
| rail | 9 | 10 | 2 | 0 | 8 | 0 | 20.0% |
| git | 9 | 8 | 2 | 6 | 0 | 0 | 62.5% |
| explorer | 7 | 4 | 2 | 1 | 1 | 0 | 62.5% |
| editor | 7 | 4 | 2 | 2 | 0 | 0 | 75.0% |
| side-panel | 5 | 5 | 3 | 1 | 1 | 0 | 70.0% |
| settings | 4 | 14 | 0 | 9 | 4 | 1 | 32.1% |
| statusbar | 3 | 3 | 0 | 2 | 1 | 0 | 33.3% |
| palette | 3 | 11 | 4 | 4 | 2 | 1 | 54.5% |
| theme | 2 | 21 | 20 | 1 | 0 | 0 | 97.6% |
| shortcuts | 1 | 7 | 3 | 2 | 1 | 1 | 57.1% |
| dialogs | 1 | 1 | 0 | 0 | 1 | 0 | 0.0% |
| browser | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| notifications | 1 | 2 | 0 | 0 | 1 | 1 | 0.0% |
| remote | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| snapshots | 0.5 | 2 | 0 | 1 | 0 | 1 | 25.0% |
| canvas | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| ssh | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |

### Ranked gaps

Rank is the reviewed impact (1 to 3) times the area weight.

| # | Surface | Status | Root cause class | Proposed unit | Rank | What differs |
| ---: | --- | --- | --- | --- | ---: | --- |
| 1 | `chat.transcript` | partial | native override needed | O5 native prose styling | 51 | The transcript, code card, task list, Worked for row and Changed files bar all render. Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule. The text check fails only because natively painted text is not in the automation tree. |
| 2 | `chat.scroll-top` | broken | needs diagnosis | O6 transcript scroll and anchoring | 51 | One wheel event of -20000 px over the transcript scrolls the web to the first turn; GPUIX stays at the bottom. chat:check scrolls through its control file, so wheel scrolling in the full app is not covered elsewhere. |
| 3 | `chat.agent-launcher` | broken | compat translator gap | C2 menus and popovers | 51 | Opening the agent and model popover crashes the pane: its error boundary shows "Something went wrong in Terminal Pane: GPUIX host node does not belong to a root". The web shows the model search popover. |
| 4 | `chat.send` | partial | needs diagnosis | O7 chat list sync and layout | 51 | Typing and Enter start a chat and the scripted reply streams in both. Mermaid shows as source ("Mermaid diagrams are shown as source in this client") where the web draws the diagram. Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule. In the Chats list two chat cards paint on top of each other once a second chat exists, and GPUIX lists only the seeded chat where the web lists all three. |
| 5 | `chat.model-selector` | partial | needs diagnosis | O7 chat list sync and layout | 34 | The running chat shows the agent chip and composer like the web. In the Chats list two chat cards paint on top of each other once a second chat exists, and GPUIX lists only the seeded chat where the web lists all three. Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule. |
| 6 | `terminal.open` | partial | compat translator gap | C15 tab title width | 28 | Terminal tab and prompt match. Pane tab titles truncate to three letters and an ellipsis ("Ter...", "note...") where the web shows the whole title, so two terminals cannot be told apart. |
| 7 | `rail.project-menu` | broken | compat translator gap | C2 menus and popovers | 27 | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. |
| 8 | `rail.add-menu` | broken | compat translator gap | C2 menus and popovers | 27 | Clicking + shows only its tooltip; the New project / New folder group dropdown does not open, so the new project modal is unreachable from the rail. |
| 9 | `rail.project-rename` | broken | compat translator gap | C2 menus and popovers | 18 | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. With no menu, the replayed clicks land on the row and the typed name goes into the composer instead. |
| 10 | `rail.project-remove` | broken | compat translator gap | C2 menus and popovers | 18 | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. No delete confirmation, so the project stays. |
| 11 | `rail.project-settings` | broken | compat translator gap | C2 menus and popovers | 18 | The gear on the hovered row shows, but clicking it does not open Project settings (also fails with real X input). |
| 12 | `palette.switch-project` | broken | needs diagnosis | C12 Enter in fields and lists | 18 | Typing beta filters to the beta row in both, but Enter switches the web to beta and leaves the GPUIX palette open on alpha. Enter in a text field or list does not run the field's action in GPUIX (form submit, command palette selection), while Enter in the chat composer does. |
| 13 | `chat.plan` | partial | native override needed | O6 transcript scroll and anchoring | 17 | The pinned Plan panel and the inline plan card match: three entries, Medium chips, the struck-through finished entry and the 1/3 count. A short transcript sits at the bottom of the GPUIX pane, leaving the space above it empty, where the web starts it at the top. The GPUIX tab title truncates to a few letters ("matr...") where the web shows the whole title. |
| 14 | `chat.permission` | partial | native override needed | O6 transcript scroll and anchoring | 17 | The Approval needed card, its Allow and Reject buttons, the Needs you badge and the status-bar pill match; clicking Allow answers allow-once in both. A short transcript sits at the bottom of the GPUIX pane, leaving the space above it empty, where the web starts it at the top. |
| 15 | `chat.queue` | partial | native override needed | O5 native prose styling | 17 | A prompt sent while the turn runs shows under 1 Queued in both, and the stop button replaces send. A short transcript sits at the bottom of the GPUIX pane, leaving the space above it empty, where the web starts it at the top. Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule. |
| 16 | `side.chats` | partial | needs diagnosis | O7 chat list sync and layout | 15 | With the one seeded chat, the card title, agent, branch and age match. Every later frame, once chat.send has started more chats, shows the overlap: In the Chats list two chat cards paint on top of each other once a second chat exists, and GPUIX lists only the seeded chat where the web lists all three. |
| 17 | `explorer.context-menu` | broken | compat translator gap | C2 menus and popovers | 14 | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. |
| 18 | `editor.markdown` | partial | native override needed | E2 markdown preview parity | 14 | Preview renders, but the "On this page" outline column is missing (still missing at fce9a3e2, after D1 brought EditorTocLayout back), headings are smaller and paragraph spacing is tighter. The tab title truncates to "guid..." where the web shows "guide.md". A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. |
| 19 | `terminal.tab-reorder` | partial | compat translator gap | C15 tab title width | 14 | Dropping Terminal 2 on the left edge of Terminal 1 moves it first in both; in GPUIX the active tab moves to the front, but both titles read "Ter...", so the order is inferred from the active tab, not read. Pane tab titles truncate to three letters and an ellipsis ("Ter...", "note...") where the web shows the whole title, so two terminals cannot be told apart. |
| 20 | `terminal.split` | partial | compat translator gap | C15 tab title width | 14 | Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1). Pane tab titles truncate to three letters and an ellipsis ("Ter...", "note...") where the web shows the whole title, so two terminals cannot be told apart. |
| 21 | `side.chat-card-menu` | broken | compat translator gap | C2 menus and popovers | 10 | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. |
| 22 | `rail.project-colour` | broken | compat translator gap | C2 menus and popovers | 9 | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. The Select Color popover never appears. |
| 23 | `rail.project-reorder` | broken | compat translator gap | C3 framer-motion Reorder drag | 9 | Dragging gamma onto alpha reorders the web list to alpha, gamma, beta; GPUIX keeps alpha, beta, gamma. D1 emulates HTML5 drag and drop, but the rail reorders through framer-motion Reorder pointer gestures, which the framer-motion shim does not drive. |
| 24 | `git.changes` | partial | compat translator gap | C5 form controls | 9 | Sections, rows, counts and history footer match. The Amend last commit checkbox box is not drawn (native checkbox input), only its label. |
| 25 | `git.diff` | partial | compat translator gap | C5 form controls | 9 | Inline diff, hunk header and STAGE HUNK match closely. The Amend last commit checkbox box is not drawn (native checkbox input), only its label. |
| 26 | `git.discard` | partial | compat translator gap | C6 overlay backdrop | 9 | The confirm dialog matches, but the modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| 27 | `git.commit` | partial | native override needed | O4 toasts | 9 | The commit lands (4 commits, bump version) in both. The toast is the sonner shim: a flat green box at the window edge with the close button on the right, where the web shows a card with a check icon and the close button at its top-left. |
| 28 | `settings.editor` | broken | native override needed | O8 native select | 8 | Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 29 | `settings.appearance` | broken | native override needed | O8 native select | 8 | Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown. Renderer and Scrollback rows wrap their descriptions one word per line. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 30 | `settings.shell` | broken | native override needed | O8 native select | 8 | Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 31 | `settings.ai-agents` | broken | native override needed | O8 native select | 8 | Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown. The Close idle chats after label wraps one or two letters per line, filling the pane; the agents list below is pushed out of view. |
| 32 | `explorer.expand` | partial | compat translator gap | C4 tooltips | 7 | A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. It covers the chevron and the open-folder icon of the expanded row. |
| 33 | `editor.tabs` | partial | native override needed | E2 markdown preview parity | 7 | Switching tabs works; README preview shows the same outline and typography gaps as editor.markdown, and the tab title truncates to "READ...". |
| 34 | `palette.type-ahead` | broken | needs diagnosis | C11 focus on open | 6 | Typing "theme" straight after Ctrl+K filters the web palette; GPUIX opens the palette with an empty search field, so the keystrokes typed before focus moved are lost. The web ranks Open Canvas first for "theme" and GPUIX ranks Agent Launcher first (seen when the filter is typed after the palette opens). |
| 35 | `settings.interface` | partial | compat translator gap | C6 overlay backdrop | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 36 | `settings.notifications` | partial | compat translator gap | C8 text colour runs | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). Row dividers inside a group are missing and rows sit tighter. |
| 37 | `settings.terminal-profiles` | partial | compat translator gap | C8 text colour runs | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 38 | `settings.skills` | partial | compat translator gap | C8 text colour runs | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 39 | `settings.provider` | partial | compat translator gap | C8 text colour runs | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). The usage line moves under the account instead of beside it. |
| 40 | `settings.mcp-servers` | partial | compat translator gap | C8 text colour runs | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). The inline code in the footnote breaks onto its own line. |
| 41 | `settings.shortcuts` | partial | compat translator gap | C8 text colour runs | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 42 | `settings.diagnostics` | partial | needs diagnosis | O9 server version source | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). Server version reads termul-server v0.1.0 in GPUIX and v0.4.52 on the web against the same server. |
| 43 | `settings.reset` | partial | compat translator gap | C6 overlay backdrop | 4 | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 44 | `statusbar.items` | partial | compat translator gap | C7 svg fill utilities | 3 | Branch, path, Terminal and settings items line up. The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored). |
| 45 | `statusbar.context-bar` | broken | compat translator gap | C2 menus and popovers | 3 | The Show in Context Bar popover (five toggles) does not open on click. |
| 46 | `statusbar.connection` | partial | compat translator gap | C4 tooltips | 3 | Hovering the connection lamp shows a Connected tooltip on the web; GPUIX shows none. The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored). |
| 47 | `palette.open-canvas` | blocked | missing GPUIX capability | V1 canvas host | 3 | Opens the canvas tab in both; see canvas.open for why the canvas itself is not compared. |
| 48 | `palette.project-settings` | partial | compat translator gap | C6 overlay backdrop | 3 | Project settings opens on General with the same fields. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| 49 | `palette.app-preferences` | partial | compat translator gap | C6 overlay backdrop | 3 | Preferences opens on Interface. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| 50 | `palette.command-history` | partial | compat translator gap | C6 overlay backdrop | 3 | The Command History modal, its scope picker and empty state match. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. No focus ring on the search field. |
| 51 | `palette.shortcut-menu` | partial | compat translator gap | C6 overlay backdrop | 3 | Opens the Shortcut Menu in both. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| 52 | `palette.report-bug` | broken | compat translator gap | C9 dialog body layout | 3 | Opens the Report a bug dialog, collapsed the same way as dialogs.bug-report. |
| 53 | `dialogs.bug-report` | broken | compat translator gap | C9 dialog body layout | 3 | The Report a bug dialog collapses to its header and footer: the Title field is cut off and the What happened, Screenshots and Preview sections are not painted, so no report can be written. |
| 54 | `shortcuts.zoom-in` | broken | native override needed | O10 UI zoom | 2 | Alt+= zooms the web UI to 110 %; GPUIX does not change scale. The UI zoom hook (hooks/use-ui-zoom.ts) is on the compat needs-override list. |
| 55 | `shortcuts.desktop-keymap` | blocked | native override needed | K2 desktop keymap for GPUIX | 2 | GPUIX boots without __TAURI_INTERNALS__, so getDefaultKeyboardShortcuts() hands it the web keymap: Alt+T, Alt+W, Alt+, and Alt+= instead of the desktop Ctrl+T, Ctrl+W, Ctrl+, and Ctrl+=, and no Ctrl+R command history. A desktop user who moves to GPUIX loses those keys. |
| 56 | `theme.picker` | partial | compat translator gap | C8 text colour runs | 2 | The Color Themes popover, groups, swatches and the current-theme check match. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). No focus ring on the search field. |
| 57 | `browser.pane` | blocked | missing GPUIX capability | V2 native webview | 2 | Not compared: browser tabs are Tauri webviews with no web-client reference, and GPUIX 0.11 has no webview element. Replacing Tauri loses the browser pane until a native webview exists. |
| 58 | `notifications.toast` | broken | needs diagnosis | C12 Enter in fields and lists | 2 | Create branch from main opens the name field in both. Typing the name and pressing Enter creates the branch and shows the success toast on the web; in GPUIX the name sits in the field and nothing happens. Enter in a text field or list does not run the field's action in GPUIX (form submit, command palette selection), while Enter in the chat composer does. Toast styling itself is compared on git.commit. |
| 59 | `shortcuts.menu` | partial | compat translator gap | C6 overlay backdrop | 1 | Shortcut Menu rows, descriptions and key chips match, including the blank Command History chip in both. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| 60 | `shortcuts.settings-shortcut` | partial | needs diagnosis | C10 dialog Escape routing | 1 | Alt+, opens Preferences in both. Escape then closes the dialog in GPUIX, where the web keeps it open. |
| 61 | `canvas.open` | blocked | missing GPUIX capability | V1 canvas host | 1 | This server build ships no figcraft bundle, so the web tab shows the BUNDLE_MISSING error JSON; GPUIX stays on Loading editor... and paints neither that error nor an editor. The canvas is a figcraft iframe (CanvasMountLayer), which GPUIX 0.11 cannot host. |
| 62 | `update.toast` | blocked | native override needed | U1 GPUIX updater and what's new | 1 | Not compared: the update toast and the what's new modal render only under isTauriContext(). GPUIX needs its own updater path to show them at all. |
| 63 | `remote.access-popover` | blocked | server route needed | R4 desktop host role over the server | 0.5 | Not compared: the popover renders only under isTauriContext(), so the web client has no reference. |
| 64 | `palette.save-snapshot` | partial | compat translator gap | C6 overlay backdrop | 0.5 | The Create Snapshot modal matches. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| 65 | `ssh.workspace` | blocked | compat translator gap | C14 SFTP table column widths | 0.5 | No web reference: SSH needs a host-local client and a browser never is one, so the web client shows no SSH section. R2 drove the GPUIX real shell as a host-local client against a throwaway sshd (reports/r2-shots): the sidebar SSH section, the hosts tab, host-key trust, a connected shell and the SFTP file list all render. In gpuix-ssh-connected.png the SFTP Modified column wraps times such as 12:26 AM onto two lines. |

### Proposed units

Each unit with the surfaces its gaps name. Gain is the usage-weighted score (all surfaces) the matrix would report if every one of those surfaces became ported, everything else unchanged.

| # | Unit | Root cause class | Surfaces | Summed rank | Gain |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | C2 menus and popovers | compat translator gap | 10 | 195 | +11.0 |
| 2 | O7 chat list sync and layout | needs diagnosis | 3 | 100 | +2.4 |
| 3 | O6 transcript scroll and anchoring | needs diagnosis | 3 | 85 | +3.8 |
| 4 | O5 native prose styling | native override needed | 2 | 68 | +1.9 |
| 5 | C15 tab title width | compat translator gap | 3 | 56 | +3.0 |
| 6 | O8 native select | native override needed | 4 | 32 | +1.1 |
| 7 | C6 overlay backdrop | compat translator gap | 9 | 30.5 | +1.6 |
| 8 | C8 text colour runs | compat translator gap | 7 | 26 | +0.9 |
| 9 | E2 markdown preview parity | native override needed | 2 | 21 | +1.8 |
| 10 | C12 Enter in fields and lists | needs diagnosis | 2 | 20 | +1.4 |
| 11 | C5 form controls | compat translator gap | 2 | 18 | +1.1 |
| 12 | C4 tooltips | compat translator gap | 2 | 10 | +1.4 |
| 13 | C3 framer-motion Reorder drag | compat translator gap | 1 | 9 | +0.9 |
| 14 | O4 toasts | native override needed | 1 | 9 | +0.6 |
| 15 | C11 focus on open | needs diagnosis | 1 | 6 | +0.3 |
| 16 | C9 dialog body layout | compat translator gap | 2 | 6 | +1.3 |
| 17 | O9 server version source | needs diagnosis | 1 | 4 | +0.1 |
| 18 | V1 canvas host | missing GPUIX capability | 2 | 4 | +0.8 |
| 19 | C7 svg fill utilities | compat translator gap | 1 | 3 | +0.5 |
| 20 | O10 UI zoom | native override needed | 1 | 2 | +0.1 |
| 21 | K2 desktop keymap for GPUIX | native override needed | 1 | 2 | +0.1 |
| 22 | V2 native webview | missing GPUIX capability | 1 | 2 | +1.0 |
| 23 | C10 dialog Escape routing | needs diagnosis | 1 | 1 | +0.1 |
| 24 | U1 GPUIX updater and what's new | native override needed | 1 | 1 | +0.5 |
| 25 | R4 desktop host role over the server | server route needed | 1 | 0.5 | +0.5 |
| 26 | C14 SFTP table column widths | compat translator gap | 1 | 0.5 | +0.5 |

If every listed unit landed and fixed its surfaces, the usage-weighted score would be 98.3%.

### Surfaces

Web and GPUIX columns count passed actions plus checks over the total. Mismatch is exact / perceptual for the last step: the full 1280x800 frame, and the region the surface names (measured in the web client, cropped from both frames).

| Surface | Area | Status | Auto | Web | GPUIX | Full mismatch | Region mismatch | Differences seen |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `rail.project-list` Project list and switching | rail | ported | ported | 7/7 | 7/7 | 5.8% / 0.99% | 3.2% / 0.55% | Same layout and order; switching to beta works by click. The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored). |
| `rail.project-menu` Project context menu | rail | broken | broken | 3/3 | 2/3 | 11.3% / 1.31% | 63.9% / 3.20% | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. |
| `rail.project-rename` Rename a project | rail | broken | broken | 8/8 | 7/8 | 26.6% / 1.72% | 9.6% / 0.72% | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. With no menu, the replayed clicks land on the row and the typed name goes into the composer instead. |
| `rail.project-remove` Remove a project | rail | broken | broken | 6/6 | 4/6 | 6.2% / 1.12% |  | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. No delete confirmation, so the project stays. |
| `rail.project-colour` Project colour picker | rail | broken | broken | 4/4 | 3/4 | 9.5% / 1.53% |  | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. The Select Color popover never appears. |
| `rail.project-reorder` Reorder projects by drag | rail | broken | broken | 4/4 | 3/4 | 7.7% / 1.40% | 9.8% / 1.07% | Dragging gamma onto alpha reorders the web list to alpha, gamma, beta; GPUIX keeps alpha, beta, gamma. D1 emulates HTML5 drag and drop, but the rail reorders through framer-motion Reorder pointer gestures, which the framer-motion shim does not drive. |
| `rail.add-menu` Add project menu and new project modal | rail | broken | broken | 5/5 | 3/5 | 98.0% / 2.52% |  | Clicking + shows only its tooltip; the New project / New folder group dropdown does not open, so the new project modal is unreachable from the rail. |
| `rail.collapse` Collapse and expand the rail | rail | ported | ported | 3/3 | 3/3 | 6.4% / 0.98% |  | Collapsed rail matches: icons, project letters, Changes badge. The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored). |
| `rail.project-settings` Project settings modal | rail | broken | broken | 5/5 | 4/5 | 65.4% / 2.94% |  | The gear on the hovered row shows, but clicking it does not open Project settings (also fails with real X input). |
| `side.chats` Chats tab with a chat card | side-panel | partial | ported | 2/2 | 2/2 | 6.2% / 1.10% | 1.5% / 0.58% | With the one seeded chat, the card title, agent, branch and age match. Every later frame, once chat.send has started more chats, shows the overlap: In the Chats list two chat cards paint on top of each other once a second chat exists, and GPUIX lists only the seeded chat where the web lists all three. |
| `side.chats-search` Search chats | side-panel | ported | ported | 7/7 | 7/7 | 6.1% / 1.09% |  | Filtering to no match and back matches, including the No matches. text. |
| `side.chat-card-menu` Chat card context menu | side-panel | broken | broken | 5/5 | 2/5 | 10.5% / 1.28% |  | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. |
| `side.workspace-switcher` Workspace (worktree) switcher | side-panel | ported | ported | 3/3 | 3/3 | 7.5% / 1.10% |  | The Working copies popover matches; GPUIX omits the small terminal glyph on the web row hover. |
| `side.hide` Hide and show the side panel | side-panel | ported | ported | 3/3 | 3/3 | 5.8% / 0.88% |  | Side panel hides; the expand chevron sits in the same place. |
| `explorer.tree` File tree | explorer | ported | ported | 6/6 | 6/6 | 6.2% / 1.06% |  | Tree, git colours and status letters match. |
| `explorer.expand` Expand a folder | explorer | partial | ported | 6/6 | 6/6 | 6.4% / 1.08% |  | A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. It covers the chevron and the open-folder icon of the expanded row. |
| `explorer.context-menu` File context menu | explorer | broken | broken | 6/6 | 4/6 | 11.6% / 1.26% |  | Right-click opens no menu: the Radix ContextMenu trigger in compat never opens, with GPUIX automation input and with real X input (XTEST, --x11-input) alike. |
| `explorer.drag` Drag a file from the tree into the pane to open it | explorer | ported | broken | 7/7 | 6/7 | 4.4% / 0.49% |  | Dragging notes.txt from the tree into the pane opens it in an editor tab in both (D1 compat drag and drop). |
| `editor.code` Code editor (CodeMirror) on a TypeScript file | editor | ported | broken | 6/6 | 5/6 | 4.3% / 0.78% |  | The native editor (E1) paints the same highlighted text, line numbers and active line; the text checks fail only because native text is painted inside GPUI and is not in the automation tree. |
| `editor.code-edit` Type into the code editor | editor | ported | broken | 9/9 | 7/9 | 4.1% / 0.75% |  | Click, End and typing put "// edited" on line 5 in both; the dirty dot shows on the tab. Same tree-text caveat as editor.code. |
| `editor.markdown` Markdown (BlockNote) editor | editor | partial | broken | 7/7 | 5/7 | 5.0% / 1.47% |  | Preview renders, but the "On this page" outline column is missing (still missing at fce9a3e2, after D1 brought EditorTocLayout back), headings are smaller and paragraph spacing is tighter. The tab title truncates to "guid..." where the web shows "guide.md". A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. |
| `editor.tabs` Two editor tabs and switching | editor | partial | broken | 8/8 | 6/8 | 4.4% / 1.12% |  | Switching tabs works; README preview shows the same outline and typography gaps as editor.markdown, and the tab title truncates to "READ...". |
| `git.changes` Changes panel: staged, unstaged, untracked | git | partial | ported | 5/5 | 5/5 | 10.5% / 1.99% |  | Sections, rows, counts and history footer match. The Amend last commit checkbox box is not drawn (native checkbox input), only its label. |
| `git.diff` Diff view of an unstaged file | git | partial | partial | 5/5 | 5/5 | 59.2% / 2.04% |  | Inline diff, hunk header and STAGE HUNK match closely. The Amend last commit checkbox box is not drawn (native checkbox input), only its label. |
| `git.stage` Stage a file | git | partial | ported | 5/5 | 5/5 | 10.6% / 1.99% |  | Staging README.md moves it to Staged 2 in both. The Amend last commit checkbox box is not drawn (native checkbox input), only its label. |
| `git.unstage` Unstage a file | git | partial | ported | 5/5 | 5/5 | 11.7% / 1.87% |  | Unstaging app.ts moves it to Changes in both. The Amend last commit checkbox box is not drawn (native checkbox input), only its label. |
| `git.discard` Discard a change (confirm dialog) | git | partial | ported | 5/5 | 5/5 | 86.5% / 1.85% |  | The confirm dialog matches, but the modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| `git.commit` Commit staged changes | git | partial | ported | 7/7 | 7/7 | 12.1% / 1.91% |  | The commit lands (4 commits, bump version) in both. The toast is the sonner shim: a flat green box at the window edge with the close button on the right, where the web shows a card with a check icon and the close button at its top-left. |
| `git.branch-picker` Branch picker | git | ported | ported | 3/3 | 3/3 | 7.4% / 1.30% |  | Branch popover, Local group, feature/login and Create branch row match. |
| `git.worktree-create` Working copies switcher: search or create a worktree | git | ported | ported | 5/5 | 5/5 | 7.6% / 1.06% |  | Typing a new name shows No matching working copies and Create worktree feat-matrix in both. |
| `chat.transcript` Open a chat: transcript, tool cards, changed files | chat | partial | broken | 5/5 | 4/5 | 18.6% / 2.53% | 25.9% / 4.52% | The transcript, code card, task list, Worked for row and Changed files bar all render. Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule. The text check fails only because natively painted text is not in the automation tree. |
| `chat.scroll-top` Transcript scrolled to the first turn | chat | broken | broken | 7/7 | 5/7 | 22.7% / 3.46% | 35.8% / 6.75% | One wheel event of -20000 px over the transcript scrolls the web to the first turn; GPUIX stays at the bottom. chat:check scrolls through its control file, so wheel scrolling in the full app is not covered elsewhere. |
| `chat.new-chat` New chat button | chat | ported | ported | 3/3 | 3/3 | 47.4% / 1.14% |  | New chat opens the launcher composer in place. |
| `chat.agent-launcher` Agent launcher menu | chat | broken | broken | 3/3 | 2/3 | 20.5% / 2.13% |  | Opening the agent and model popover crashes the pane: its error boundary shows "Something went wrong in Terminal Pane: GPUIX host node does not belong to a root". The web shows the model search popover. |
| `chat.send` Send a prompt from the dashboard and stream the reply | chat | partial | broken | 7/7 | 6/7 | 24.0% / 5.58% |  | Typing and Enter start a chat and the scripted reply streams in both. Mermaid shows as source ("Mermaid diagrams are shown as source in this client") where the web draws the diagram. Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule. In the Chats list two chat cards paint on top of each other once a second chat exists, and GPUIX lists only the seeded chat where the web lists all three. |
| `chat.model-selector` Model and mode selector in a running chat | chat | partial | partial | 4/4 | 4/4 | 21.0% / 2.80% |  | The running chat shows the agent chip and composer like the web. In the Chats list two chat cards paint on top of each other once a second chat exists, and GPUIX lists only the seeded chat where the web lists all three. Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule. |
| `chat.plan` Plan panel from a plan update | chat | partial | broken | 10/10 | 9/10 | 28.4% / 2.09% |  | The pinned Plan panel and the inline plan card match: three entries, Medium chips, the struck-through finished entry and the 1/3 count. A short transcript sits at the bottom of the GPUIX pane, leaving the space above it empty, where the web starts it at the top. The GPUIX tab title truncates to a few letters ("matr...") where the web shows the whole title. |
| `chat.permission` Permission prompt: allow a tool call | chat | partial | broken | 12/12 | 11/12 | 10.6% / 1.32% |  | The Approval needed card, its Allow and Reject buttons, the Needs you badge and the status-bar pill match; clicking Allow answers allow-once in both. A short transcript sits at the bottom of the GPUIX pane, leaving the space above it empty, where the web starts it at the top. |
| `chat.queue` Prompt queue while a turn runs | chat | partial | broken | 12/12 | 11/12 | 18.4% / 1.77% |  | A prompt sent while the turn runs shows under 1 Queued in both, and the stop button replaces send. A short transcript sits at the bottom of the GPUIX pane, leaving the space above it empty, where the web starts it at the top. Native markdown prose loses inline-code chips, link colour and italics, and some runs pick up a warm tint; a blockquote gets a filled background instead of a rule. |
| `composer.mention` Mention menu (@) | composer | ported | ported | 4/4 | 4/4 | 7.2% / 1.62% |  | Both show "No files or folders match" for a bare @ on this server, so the file list itself is not compared here (tools/composer/e2e.ts covers it). The web draws a focus ring on the composer; GPUIX does not. |
| `composer.slash` Slash command menu (/) | composer | ported | ported | 4/4 | 4/4 | 9.9% / 1.67% |  | The Skills menu matches row for row. No focus ring on the GPUIX composer. |
| `composer.attach` Attach files button | composer | ported | ported | 2/2 | 2/2 | 8.7% / 1.60% |  | Clicking Attach files opens nothing visible in either client in this headless run (the web file chooser is a native dialog Playwright does not paint). |
| `terminal.open` Open a terminal from the status bar | terminal | partial | ported | 4/4 | 4/4 | 4.2% / 0.96% |  | Terminal tab and prompt match. Pane tab titles truncate to three letters and an ellipsis ("Ter...", "note...") where the web shows the whole title, so two terminals cannot be told apart. |
| `terminal.type` Type a command and see its output | terminal | ported | ported | 5/5 | 5/5 | 3.2% / 0.95% |  | echo output matches cell for cell. |
| `terminal.vim-replies` Terminal query replies after vim (T1 fixture shape) | terminal | ported | ported | 8/8 | 8/8 | 4.2% / 1.49% |  | With the O1 fixture's command (vim -u NONE -N notes.txt, then :q!) typed into the full app, both clients return to a clean prompt; neither echoes ^[[>0;276;0c or rgb: replies. So the echo in O1's GPUIX shot does not reproduce in the full app with typed input: it belongs to the fixture, which writes its inputs to the PTY back to back, not to GPUIX (inferred; the fixture itself was not rerun here). |
| `terminal.file-link` Ctrl+click a file path in terminal output opens it in the editor | terminal | ported | broken | 8/8 | 7/8 | 4.3% / 0.99% |  | Ctrl+click on src/app.ts in terminal output opens app.ts in a new tab in both. The text check fails only because natively painted text is not in the automation tree. |
| `terminal.new-tab-menu` New tab menu (terminal, browser, ...) | terminal | ported | ported | 3/3 | 3/3 | 7.8% / 1.36% |  | The new tab menu matches. |
| `terminal.tab-reorder` Reorder terminal tabs by dragging | terminal | partial | ported | 10/10 | 10/10 | 2.6% / 0.58% |  | Dropping Terminal 2 on the left edge of Terminal 1 moves it first in both; in GPUIX the active tab moves to the front, but both titles read "Ter...", so the order is inferred from the active tab, not read. Pane tab titles truncate to three letters and an ellipsis ("Ter...", "note...") where the web shows the whole title, so two terminals cannot be told apart. |
| `terminal.split` Split panes: drag a second terminal tab to the pane edge | terminal | partial | ported | 12/12 | 12/12 | 2.9% / 0.89% |  | Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1). Pane tab titles truncate to three letters and an ellipsis ("Ter...", "note...") where the web shows the whole title, so two terminals cannot be told apart. |
| `statusbar.items` Status bar items | statusbar | partial | partial | 2/2 | 2/2 | 6.6% / 1.31% | 12.7% / 5.64% | Branch, path, Terminal and settings items line up. The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored). |
| `statusbar.context-bar` Context bar settings popover | statusbar | broken | broken | 3/3 | 2/3 | 11.6% / 1.68% |  | The Show in Context Bar popover (five toggles) does not open on click. |
| `statusbar.connection` Connection indicator hover | statusbar | partial | ported | 3/3 | 3/3 | 7.1% / 1.35% |  | Hovering the connection lamp shows a Connected tooltip on the web; GPUIX shows none. The status-bar connection lamp is an outline ring instead of a filled dot (fill-current on the icon is ignored). |
| `remote.access-popover` Remote access popover (desktop shared-live host) | remote | blocked | blocked | n/a | n/a |  |  | Not compared: the popover renders only under isTauriContext(), so the web client has no reference. |
| `settings.interface` Settings: Interface | settings | partial | ported | 5/5 | 5/5 | 32.0% / 1.37% | 4.4% / 1.65% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `settings.notifications` Settings: Notifications | settings | partial | partial | 5/5 | 5/5 | 34.1% / 1.70% | 7.5% / 2.13% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). Row dividers inside a group are missing and rows sit tighter. |
| `settings.editor` Settings: Editor | settings | broken | ported | 5/5 | 5/5 | 32.8% / 1.19% | 5.6% / 1.37% | Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `settings.appearance` Settings: Appearance | settings | broken | partial | 5/5 | 5/5 | 41.5% / 2.04% | 18.5% / 2.63% | Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown. Renderer and Scrollback rows wrap their descriptions one word per line. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `settings.shell` Settings: Shell | settings | broken | ported | 5/5 | 5/5 | 31.8% / 0.95% | 4.1% / 1.02% | Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `settings.terminal-profiles` Settings: Profiles | settings | partial | ported | 5/5 | 5/5 | 31.2% / 0.95% | 3.3% / 1.03% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `settings.ai-agents` Settings: Agent chats | settings | broken | partial | 5/5 | 5/5 | 49.6% / 1.79% | 30.3% / 2.25% | Each native select renders as a chevron button plus every option laid out as plain text in the row, which squeezes the label column; the web shows one closed dropdown. The Close idle chats after label wraps one or two letters per line, filling the pane; the agents list below is pushed out of view. |
| `settings.skills` Settings: Skills | settings | partial | partial | 5/5 | 5/5 | 35.9% / 2.33% | 10.2% / 3.06% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `settings.provider` Settings: Accounts | settings | partial | ported | 5/5 | 5/5 | 32.4% / 1.13% | 5.1% / 1.29% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). The usage line moves under the account instead of beside it. |
| `settings.mcp-servers` Settings: MCP servers | settings | partial | partial | 5/5 | 5/5 | 35.3% / 1.82% | 9.4% / 2.30% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). The inline code in the footnote breaks onto its own line. |
| `settings.shortcuts` Settings: Keyboard shortcuts | settings | partial | partial | 5/5 | 5/5 | 34.8% / 2.00% | 8.6% / 2.57% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `settings.diagnostics` Settings: Logs | settings | partial | partial | 5/5 | 5/5 | 35.5% / 1.79% | 9.6% / 2.26% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). Server version reads termul-server v0.1.0 in GPUIX and v0.4.52 on the web against the same server. |
| `settings.reset` Settings: Reset | settings | partial | ported | 5/5 | 5/5 | 31.2% / 1.12% | 3.3% / 1.27% | The section content and navigation match. The modal backdrop is far lighter than the web bg-overlay. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `palette.open` Command palette (Ctrl+K) and filtering | palette | ported | ported | 9/9 | 9/9 | 7.6% / 1.82% |  |  |
| `palette.type-ahead` Typing straight after Ctrl+K reaches the palette filter | palette | broken | broken | 5/5 | 4/5 | 75.5% / 1.97% |  | Typing "theme" straight after Ctrl+K filters the web palette; GPUIX opens the palette with an empty search field, so the keystrokes typed before focus moved are lost. The web ranks Open Canvas first for "theme" and GPUIX ranks Agent Launcher first (seen when the filter is typed after the palette opens). |
| `palette.new-terminal` Palette command: New Terminal | palette | ported | ported | 8/8 | 8/8 | 3.7% / 1.28% |  | New Terminal opens Terminal 1 in both. |
| `palette.agent-launcher` Palette command: Agent Launcher | palette | ported | ported | 9/9 | 9/9 | 48.6% / 1.75% |  | Agent Launcher shows the launcher with its close button in both. |
| `palette.save-snapshot` Palette command: Save Workspace Snapshot | snapshots | partial | ported | 9/9 | 9/9 | 82.7% / 1.39% |  | The Create Snapshot modal matches. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). |
| `palette.open-canvas` Palette command: Open Canvas | palette | blocked | partial | 9/9 | 9/9 | 5.7% / 2.92% |  | Opens the canvas tab in both; see canvas.open for why the canvas itself is not compared. |
| `palette.project-settings` Palette command: Project Settings | palette | partial | ported | 9/9 | 9/9 | 30.8% / 0.84% |  | Project settings opens on General with the same fields. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| `palette.app-preferences` Palette command: App Preferences | palette | partial | ported | 9/9 | 9/9 | 32.0% / 1.37% |  | Preferences opens on Interface. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| `palette.switch-project` Palette command: beta | rail | broken | broken | 9/9 | 8/9 | 100.0% / 2.16% |  | Typing beta filters to the beta row in both, but Enter switches the web to beta and leaves the GPUIX palette open on alpha. Enter in a text field or list does not run the field's action in GPUIX (form submit, command palette selection), while Enter in the chat composer does. |
| `palette.command-history` Palette command: Command History | palette | partial | ported | 9/9 | 9/9 | 81.7% / 1.48% |  | The Command History modal, its scope picker and empty state match. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. No focus ring on the search field. |
| `palette.color-theme` Palette command: Change Color Theme | palette | ported | ported | 9/9 | 9/9 | 23.3% / 1.54% |  | Change Color Theme opens the Color Themes popover in both; see theme.picker for its tint. |
| `palette.shortcut-menu` Palette command: Open Shortcut Menu | palette | partial | ported | 9/9 | 9/9 | 78.3% / 1.79% |  | Opens the Shortcut Menu in both. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| `palette.report-bug` Palette command: Report a Bug | palette | broken | partial | 9/9 | 9/9 | 80.1% / 2.04% |  | Opens the Report a bug dialog, collapsed the same way as dialogs.bug-report. |
| `shortcuts.menu` Keyboard shortcuts popover | shortcuts | partial | ported | 3/3 | 3/3 | 76.5% / 1.80% |  | Shortcut Menu rows, descriptions and key chips match, including the blank Command History chip in both. The modal backdrop is far lighter than the web bg-overlay, so the page behind stays readable. |
| `shortcuts.settings-shortcut` Settings shortcut (Alt+,); Escape leaves the web dialog open | shortcuts | partial | broken | 6/6 | 5/6 | 63.8% / 3.16% |  | Alt+, opens Preferences in both. Escape then closes the dialog in GPUIX, where the web keeps it open. |
| `shortcuts.toggle-projects` Default shortcut ctrl-shift-b: collapse the project rail | shortcuts | ported | ported | 5/5 | 5/5 | 7.9% / 1.72% |  | Ctrl+Shift+B collapses the rail in both. |
| `shortcuts.toggle-side-panel` Default shortcut ctrl-b: hide the side panel | shortcuts | ported | ported | 5/5 | 5/5 | 5.8% / 0.88% |  | Ctrl+B hides the side panel in both. |
| `shortcuts.theme-picker` Default shortcut ctrl-alt-t: theme picker | shortcuts | ported | ported | 5/5 | 5/5 | 23.3% / 1.48% |  | Ctrl+Alt+T opens the Color Themes popover in both. |
| `shortcuts.zoom-in` Default shortcut alt-=: zoom in | shortcuts | broken | partial | 5/5 | 5/5 | 20.6% / 2.92% |  | Alt+= zooms the web UI to 110 %; GPUIX does not change scale. The UI zoom hook (hooks/use-ui-zoom.ts) is on the compat needs-override list. |
| `shortcuts.desktop-keymap` Desktop key bindings (Ctrl+T, Ctrl+W, Ctrl+R, Ctrl+, and Ctrl+=) | shortcuts | blocked | blocked | n/a | n/a |  |  | GPUIX boots without __TAURI_INTERNALS__, so getDefaultKeyboardShortcuts() hands it the web keymap: Alt+T, Alt+W, Alt+, and Alt+= instead of the desktop Ctrl+T, Ctrl+W, Ctrl+, and Ctrl+=, and no Ctrl+R command history. A desktop user who moves to GPUIX loses those keys. |
| `theme.picker` Theme picker | theme | partial | ported | 4/4 | 4/4 | 20.4% / 1.52% |  | The Color Themes popover, groups, swatches and the current-theme check match. Some words in labels and descriptions paint in an accent or warm colour (word runs pick up a colour the web text does not have). No focus ring on the search field. |
| `dialogs.bug-report` Report a bug dialog | dialogs | broken | partial | 3/3 | 3/3 | 80.1% / 2.04% |  | The Report a bug dialog collapses to its header and footer: the Title field is cut off and the What happened, Screenshots and Preview sections are not painted, so no report can be written. |
| `canvas.open` Canvas | canvas | blocked | partial | 4/4 | 4/4 | 4.9% / 2.45% |  | This server build ships no figcraft bundle, so the web tab shows the BUNDLE_MISSING error JSON; GPUIX stays on Loading editor... and paints neither that error nor an editor. The canvas is a figcraft iframe (CanvasMountLayer), which GPUIX 0.11 cannot host. |
| `browser.pane` Browser pane | browser | blocked | blocked | n/a | n/a |  |  | Not compared: browser tabs are Tauri webviews with no web-client reference, and GPUIX 0.11 has no webview element. Replacing Tauri loses the browser pane until a native webview exists. |
| `notifications.toast` Toast after creating a branch | notifications | broken | broken | 7/7 | 6/7 | 14.8% / 1.65% |  | Create branch from main opens the name field in both. Typing the name and pressing Enter creates the branch and shows the success toast on the web; in GPUIX the name sits in the field and nothing happens. Enter in a text field or list does not run the field's action in GPUIX (form submit, command palette selection), while Enter in the chat composer does. Toast styling itself is compared on git.commit. |
| `ssh.workspace` SSH profiles and sessions | ssh | blocked | pending-unit | n/a | n/a |  |  | No web reference: SSH needs a host-local client and a browser never is one, so the web client shows no SSH section. R2 drove the GPUIX real shell as a host-local client against a throwaway sshd (reports/r2-shots): the sidebar SSH section, the hosts tab, host-key trust, a connected shell and the SFTP file list all render. In gpuix-ssh-connected.png the SFTP Modified column wraps times such as 12:26 AM onto two lines. |
| `settings.accounts-claude` Claude account sign-in | settings | blocked | pending-unit | n/a | n/a |  |  | No web reference: Claude account management needs a host-local client. The R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path; no GPUIX pixel check of the sign-in flow exists yet. |
| `update.toast` Update available toast and what's new modal | notifications | blocked | blocked | n/a | n/a |  |  | Not compared: the update toast and the what's new modal render only under isTauriContext(). GPUIX needs its own updater path to show them at all. |
| `snapshots.page` Snapshots page (#/snapshots) | snapshots | blocked | blocked | n/a | n/a |  |  |  |
| `theme.termul-dark` Theme termul (dark) | theme | ported | ported | 2/2 | 2/2 | 6.6% / 1.32% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.termul-light` Theme termul (light) | theme | ported | ported | 2/2 | 2/2 | 4.4% / 1.34% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.cursor-dark` Theme cursor (dark) | theme | ported | ported | 2/2 | 2/2 | 3.9% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.cursor-light` Theme cursor (light) | theme | ported | ported | 2/2 | 2/2 | 4.4% / 1.32% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.catppuccin-dark` Theme catppuccin (dark) | theme | ported | ported | 2/2 | 2/2 | 6.5% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.catppuccin-light` Theme catppuccin (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.dracula-dark` Theme dracula (dark) | theme | ported | ported | 2/2 | 2/2 | 4.3% / 1.26% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.dracula-light` Theme dracula (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.29% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.nord-dark` Theme nord (dark) | theme | ported | ported | 2/2 | 2/2 | 4.3% / 1.27% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.nord-light` Theme nord (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.27% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.gruvbox-dark` Theme gruvbox (dark) | theme | ported | ported | 2/2 | 2/2 | 6.5% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.gruvbox-light` Theme gruvbox (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.26% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.tokyonight-dark` Theme tokyonight (dark) | theme | ported | ported | 2/2 | 2/2 | 6.5% / 1.24% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.tokyonight-light` Theme tokyonight (light) | theme | ported | ported | 2/2 | 2/2 | 4.4% / 1.07% |  | Colours match the web dashboard. In the first full run this GPUIX launch crashed to "Uncaught runtime errors: Timed out after 2 seconds waiting for the automation bounds query" (compat live-reads from a tanstack-virtual resize); the rerun booted cleanly, so the crash is intermittent. |
| `theme.ayu-dark` Theme ayu (dark) | theme | ported | ported | 2/2 | 2/2 | 4.4% / 1.23% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.ayu-light` Theme ayu (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.27% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.one-dark-dark` Theme one-dark (dark) | theme | ported | ported | 2/2 | 2/2 | 6.5% / 1.22% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.one-dark-light` Theme one-dark (light) | theme | ported | ported | 2/2 | 2/2 | 4.8% / 1.29% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.github-dark` Theme github (dark) | theme | ported | ported | 2/2 | 2/2 | 6.1% / 1.23% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |
| `theme.github-light` Theme github (light) | theme | ported | ported | 2/2 | 2/2 | 4.5% / 1.35% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme: the overlapping chat cards (chat.send) and the outline connection lamp (statusbar.items). |

### Driven interactions and literal results

- `rail.project-list` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-project-list/`):
  - `a-dashboard`: present "alpha": web pass, gpuix pass; present "beta": web pass, gpuix pass; present "gamma": web pass, gpuix pass; present "delta": web pass, gpuix pass; present "What should we do in alpha?": web pass, gpuix pass
  - `b-switch-beta`: click #project-item-m1-beta (web ok; gpuix ok via testid); present "What should we do in beta?": web pass, gpuix pass
- `rail.project-menu` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-project-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: right-click #project-item-m1-beta (web ok; gpuix ok via testid); present "Rename": web pass, gpuix FAIL
- `rail.project-rename` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-project-rename/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-rename`: right-click #project-item-m1-gamma (web ok; gpuix ok via testid); click "Rename" (web ok; gpuix ok via web-point); click [data-testid="shell-rail"] input (web ok; gpuix ok via web-point); press ctrl-a (web ok; gpuix ok via key); type "gamma-renamed" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); present "gamma-renamed": web pass, gpuix FAIL
- `rail.project-remove` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-project-remove/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-confirm`: right-click #project-item-m1-delta (web ok; gpuix ok via testid); click "Delete" (web ok; gpuix ok via web-point); present "Delete Project": web pass, gpuix FAIL
  - `c-removed`: click [Delete] (web ok; gpuix ok via web-point); gone "delta": web pass, gpuix FAIL
- `rail.project-colour` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-project-colour/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: right-click #project-item-m1-beta (web ok; gpuix ok via testid); click "Change Color" (web ok; gpuix ok via web-point); present "Select Color": web pass, gpuix FAIL
- `rail.project-reorder` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-project-reorder/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-dragged`: drag #project-item-m1-gamma -> #project-item-m1-alpha (web ok; gpuix ok via testid); wait 500 ms (web ok; gpuix ok via none); present "alpha < gamma < beta": web pass, gpuix FAIL
- `rail.add-menu` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-add-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [Add project or folder group] (web ok; gpuix ok via web-point); present "New project": web pass, gpuix FAIL
  - `c-modal`: click "New project" (web ok; gpuix ok via web-point); present "Create": web pass, gpuix FAIL
- `rail.collapse` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-collapse/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-collapsed`: click [Expand or collapse projects] (web ok; gpuix ok via web-point); gone "Projects": web pass, gpuix pass
- `rail.project-settings` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/rail-project-settings/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-beta`: click #project-item-m1-beta (web ok; gpuix ok via testid); present "What should we do in beta?": web pass, gpuix pass
  - `c-settings`: click [Settings for beta] (web ok; gpuix ok via web-point); present "Basic project identification and location.": web pass, gpuix FAIL
- `side.chats` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/side-chats/`):
  - `a-chats`: present "How does the web client decide which routes rend": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass
- `side.chats-search` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/side-chats-search/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-miss`: click input[placeholder^="Search chats"] (web ok; gpuix ok via web-point); type "zzz-no-match" (web ok; gpuix ok via key); gone "How does the web client decide which routes rend": web pass, gpuix pass
  - `c-hit`: press ctrl-a (web ok; gpuix ok via key); type "routes" (web ok; gpuix ok via key); present "How does the web client decide which routes rend": web pass, gpuix pass
- `side.chat-card-menu` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/side-chat-card-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: right-click "How does the web client decide which routes rend" (web ok; gpuix ok via text); present "Open in split": web pass, gpuix FAIL; present "Copy Path": web pass, gpuix FAIL; present "Delete Chat": web pass, gpuix FAIL
- `side.workspace-switcher` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/side-workspace-switcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Workspace] (web ok; gpuix ok via web-point); present "Current checkout": web pass, gpuix pass
- `side.hide` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/side-hide/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-hidden`: click [Hide side panel] (web ok; gpuix ok via web-point); gone "How does the web client decide which routes rend": web pass, gpuix pass
- `explorer.tree` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/explorer-tree/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "src": web pass, gpuix pass; present "docs": web pass, gpuix pass; present "README.md": web pass, gpuix pass; present "notes.txt": web pass, gpuix pass
- `explorer.expand` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/explorer-expand/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "src": web pass, gpuix pass
  - `c-expanded`: click "src" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass; present "utils.ts": web pass, gpuix pass
- `explorer.context-menu` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/explorer-context-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-menu`: right-click "README.md" (web ok; gpuix ok via text); present "Rename": web pass, gpuix FAIL; present "Delete": web pass, gpuix FAIL
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
- `editor.markdown` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/editor-markdown/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); click "docs" (web ok; gpuix ok via text); present "guide.md": web pass, gpuix pass
  - `c-open`: click "guide.md" (web ok; gpuix ok via text); present "Alpha guide": web pass, gpuix FAIL; present "Setup": web pass, gpuix FAIL
- `editor.tabs` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/editor-tabs/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click "Explorer" (web ok; gpuix ok via text); click "README.md" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
  - `c-back`: click [role="tab"]:has-text("README.md") (web ok; gpuix ok via web-point); present "The matrix project.": web pass, gpuix FAIL
- `git.changes` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-changes/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass; present "README.md": web pass, gpuix pass; present "notes.txt": web pass, gpuix pass
- `git.diff` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-diff/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-diff`: click "README.md" (web ok; gpuix ok via text); present "An unstaged line.": web pass, gpuix pass
- `git.stage` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-stage/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-staged`: click [Stage changes] (web ok; gpuix ok via web-point); present "README.md": web pass, gpuix pass
- `git.unstage` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-unstage/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-unstaged`: click [Unstage changes] (web ok; gpuix ok via web-point); present "app.ts": web pass, gpuix pass
- `git.discard` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-discard/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-confirm`: click [Discard changes] (web ok; gpuix ok via web-point); present "Discard": web pass, gpuix pass
- `git.commit` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-commit/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-message`: click input[placeholder="Summary (required)"] (web ok; gpuix ok via web-point); type "bump version" (web ok; gpuix ok via key)
  - `d-committed`: click [Commit to main] (web ok; gpuix ok via web-point); gone "app.ts": web pass, gpuix pass
- `git.branch-picker` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-branch-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: click [Switch git branch] (web ok; gpuix ok via web-point); present "feature/login": web pass, gpuix pass
- `git.worktree-create` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/git-worktree-create/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-switcher`: click [Workspace] (web ok; gpuix ok via web-point); present "main": web pass, gpuix pass
  - `c-typed`: type "feat-matrix" (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none)
- `chat.transcript` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-transcript/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "One more place parses it": web pass, gpuix FAIL; present "Changed files": web pass, gpuix pass
- `chat.scroll-top` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-scroll-top/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "One more place parses it": web pass, gpuix FAIL
  - `c-top`: wheel -20000 over "One more place parses it" (web ok; gpuix ok via web-point); wait 1200 ms (web ok; gpuix ok via none); present "Three call sites depend on it": web pass, gpuix FAIL
- `chat.new-chat` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-new-chat/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-new`: click [New chat] (web ok; gpuix ok via web-point); present "Chat Scenario Agent": web pass, gpuix pass
- `chat.agent-launcher` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-agent-launcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click button[aria-label^="Agent and model"] (web ok; gpuix ok via web-point); present "This agent gives no model": web pass, gpuix FAIL
- `chat.send` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-send/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-typed`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "Explain the router" (web ok; gpuix ok via key); present "Explain the router": web pass, gpuix pass
  - `c-reply`: press enter (web ok; gpuix ok via key); wait 4000 ms (web ok; gpuix ok via none); present "The router docs cover the hash variant in more depth": web pass, gpuix FAIL
- `chat.model-selector` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-model-selector/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1000 ms (web ok; gpuix ok via none); present "Chat Scenario Agent": web pass, gpuix pass
- `chat.plan` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-plan/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-reply`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix plan" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 3000 ms (web ok; gpuix ok via none); present "Here is the plan for the router work.": web pass, gpuix FAIL
  - `c-panel`: present "Plan": web pass, gpuix pass; present "Read the router module": web pass, gpuix pass; present "Write the hash router tests": web pass, gpuix pass; present "Update the router docs": web pass, gpuix pass
- `chat.permission` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-permission/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-prompt`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix permission" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 3000 ms (web ok; gpuix ok via none); present "Run the router test suite": web pass, gpuix pass; present "Allow": web pass, gpuix pass; present "Reject": web pass, gpuix pass
  - `c-allowed`: click "Allow" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "Permission answer: allow-once": web pass, gpuix FAIL; gone "Reject": web pass, gpuix pass
- `chat.queue` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/chat-queue/`):
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
- `terminal.open` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/terminal-open/`):
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
- `terminal.new-tab-menu` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/terminal-new-tab-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [New tab] (web ok; gpuix ok via web-point); present "Terminal": web pass, gpuix pass
- `terminal.tab-reorder` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/terminal-tab-reorder/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); click [New tab] (web ok; gpuix ok via web-point); click [Bash] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
  - `c-reordered`: drag "Terminal 2" -> [role="tab"]:has-text("Terminal 1") (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none)
- `terminal.split` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/terminal-split/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); click [New tab] (web ok; gpuix ok via web-point); click [Bash] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
  - `c-split`: drag "Terminal 2" -> [data-pane-content] (web ok; gpuix ok via text); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
- `statusbar.items` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/statusbar-items/`):
  - `a-dashboard`: present "main": web pass, gpuix pass; present "Terminal": web pass, gpuix pass
- `statusbar.context-bar` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/statusbar-context-bar/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-popover`: click [Context bar settings] (web ok; gpuix ok via web-point); present "Branch": web pass, gpuix FAIL
- `statusbar.connection` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/statusbar-connection/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-hover`: hover [Connected] (web ok; gpuix ok via web-point); wait 1200 ms (web ok; gpuix ok via none)
- `remote.access-popover`: StatusBar renders RemoteAccessPopover only under isTauriContext(); the web client has none to compare, and GPUIX would need the desktop host role from the server
- `settings.interface` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-interface/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Interface" (web ok; gpuix ok via text); present "Interface zoom": web pass, gpuix pass
- `settings.notifications` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-notifications/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Notifications" (web ok; gpuix ok via text); present "Notify when a terminal agent finishes": web pass, gpuix pass
- `settings.editor` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-editor/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Editor" (web ok; gpuix ok via text); present "Auto save delay": web pass, gpuix pass
- `settings.appearance` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-appearance/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Appearance" (web ok; gpuix ok via text); present "Font size": web pass, gpuix pass
- `settings.shell` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-shell/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Shell" (web ok; gpuix ok via text); present "Default shell": web pass, gpuix pass
- `settings.terminal-profiles` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-terminal-profiles/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Profiles" (web ok; gpuix ok via text); present "No terminal profiles": web pass, gpuix pass
- `settings.ai-agents` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-ai-agents/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Agent chats" (web ok; gpuix ok via text); present "Close idle chats after": web pass, gpuix pass
- `settings.skills` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-skills/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Skills" (web ok; gpuix ok via text); present "Skills": web pass, gpuix pass
- `settings.provider` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-provider/`):
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
- `settings.diagnostics` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-diagnostics/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Logs" (web ok; gpuix ok via text); present "Application log": web pass, gpuix pass
- `settings.reset` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/settings-reset/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Reset" (web ok; gpuix ok via text); present "Reset all settings": web pass, gpuix pass
- `palette.open` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: press ctrl-k (web ok; gpuix ok via key); present "App Preferences": web pass, gpuix pass; present "New Terminal": web pass, gpuix pass
  - `c-filter`: type "theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `d-escape`: press escape (web ok; gpuix ok via key); gone "Change Color Theme": web pass, gpuix pass
- `palette.type-ahead` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-type-ahead/`):
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
- `palette.save-snapshot` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-save-snapshot/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Save Workspace Snapshot" (web ok; gpuix ok via key); present "Save Workspace Snapshot": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Save Workspace Snapshot" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Snapshot": web pass, gpuix pass
- `palette.open-canvas` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-open-canvas/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Open Canvas" (web ok; gpuix ok via key); present "Open Canvas": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Open Canvas" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Canvas": web pass, gpuix pass
- `palette.project-settings` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-project-settings/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Project Settings" (web ok; gpuix ok via key); present "Project Settings": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Project Settings" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Basic project identification and location.": web pass, gpuix pass
- `palette.app-preferences` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-app-preferences/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "App Preferences" (web ok; gpuix ok via key); present "App Preferences": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "App Preferences" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Interface zoom": web pass, gpuix pass
- `palette.switch-project` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-switch-project/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "beta" (web ok; gpuix ok via key); present "beta": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: press enter (web ok; gpuix ok via key); wait 1200 ms (web ok; gpuix ok via none); present "What should we do in beta?": web pass, gpuix FAIL
- `palette.command-history` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-command-history/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Command History" (web ok; gpuix ok via key); present "Command History": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Command History" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Command History": web pass, gpuix pass
- `palette.color-theme` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-color-theme/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Change Color Theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Change Color Theme" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Dracula": web pass, gpuix pass
- `palette.shortcut-menu` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-shortcut-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Open Shortcut Menu" (web ok; gpuix ok via key); present "Open Shortcut Menu": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Open Shortcut Menu" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Shortcut Menu": web pass, gpuix pass
- `palette.report-bug` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/palette-report-bug/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Report a Bug" (web ok; gpuix ok via key); present "Report a Bug": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Report a Bug" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Report a bug": web pass, gpuix pass
- `shortcuts.menu` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/shortcuts-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Open keyboard shortcuts menu] (web ok; gpuix ok via web-point); present "Shortcut Menu": web pass, gpuix pass
- `shortcuts.settings-shortcut` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/shortcuts-settings-shortcut/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: press alt-, (web ok; gpuix ok via key); present "Interface zoom": web pass, gpuix pass
  - `c-escape`: press escape (web ok; gpuix ok via key); wait 600 ms (web ok; gpuix ok via none); present "Interface zoom": web pass, gpuix FAIL
- `shortcuts.toggle-projects` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/shortcuts-toggle-projects/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-shift-b (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "gamma": web pass, gpuix pass
- `shortcuts.toggle-side-panel` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/shortcuts-toggle-side-panel/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-b (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "Explorer": web pass, gpuix pass
- `shortcuts.theme-picker` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/shortcuts-theme-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-alt-t (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "Color Themes": web pass, gpuix pass
- `shortcuts.zoom-in` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/shortcuts-zoom-in/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press alt-= (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `shortcuts.desktop-keymap`: No web reference: the web client swaps browser-reserved keys for Alt combos, and GPUIX inherits that keymap because it is not a Tauri context
- `theme.picker` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Color themes] (web ok; gpuix ok via web-point); present "Dracula": web pass, gpuix pass; present "Nord": web pass, gpuix pass
- `dialogs.bug-report` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/dialogs-bug-report/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Report a bug] (web ok; gpuix ok via web-point); present "Report a bug": web pass, gpuix pass
- `canvas.open` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/canvas-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Open canvas] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); present "Canvas": web pass, gpuix pass
- `browser.pane`: Browser tabs are Tauri native webviews; the web client offers no New Browser Tab, so there is no reference, and GPUIX 0.11 has no webview element
- `notifications.toast` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/notifications-toast/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: click [Switch git branch] (web ok; gpuix ok via web-point); click "Create branch from" (web ok; gpuix ok via text)
  - `c-toast`: type "toast-branch" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); present "Created and checked out toast-branch": web pass, gpuix FAIL
- `ssh.workspace`: No web reference: SSH needs a host-local client (useHostGate(canUseHostSsh)), which a browser never is; R2 drove the GPUIX flow against a throwaway sshd (reports/r2-shots)
- `settings.accounts-claude`: No web reference: Claude account management needs a host-local client, which a browser never is; the R1-R3 e2e kit (reports/r1-e2e, accounts mode) covers the server path
- `update.toast`: Both render only when isTauriContext() is true (App.tsx WhatsNewModal, UpdateAvailableToast); the web client never shows them, so there is no reference to compare against
- `snapshots.page`: The desktop shell has no link to the route; only the mobile drawer navigates to it, and GPUIX cannot start on a hash route yet
- `theme.termul-dark` (frames `/root/termul-wt/gpuix-m1/apps/gpuix/parity-out/matrix/theme-termul-dark/`):
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
