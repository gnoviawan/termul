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

Five surfaces need more than the web client (R5; see References below).
`ssh.workspace` and `settings.accounts-claude` need a `termul-server` that
writes the host-local credential: the shared release build does, the older
`/root/gpuix-bin/termul-server` does not, and the run stops with that
advice. `browser.pane` needs the desktop app built from the same checkout
(at the repo root) and the webview helper in `dist/`:

```sh
CARGO_TARGET_DIR=/root/termul-wt/gpuix/src-tauri/target \
  bun x tauri build --config src-tauri/tauri.conf.dev.json --no-bundle
cd apps/gpuix
CARGO_TARGET_DIR=/root/termul-wt/gpuix/src-tauri/target bun tools/webview-host.ts --release
TERMUL_SERVER_BIN=/root/termul-wt/gpuix/src-tauri/target/release/termul-server \
  bun run parity:matrix --only browser.pane,ssh.workspace,settings.accounts-claude,shortcuts.desktop-keymap,snapshots.page
```

`TERMUL_TAURI_BIN` points the run at another desktop build.

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
   1280x800, dark, reduced motion, slight font hinting as on a desktop:
   `tools/shared/chromium.ts`) and then in GPUIX (Xvfb, lavapipe,
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
6. A surface names its reference (`Reference` in `types.ts`). Most compare
   against the web client. `web-host-local` adds the server's host-local
   credential to the web client's `/ws` handshake through a Playwright
   WebSocket route (`host-local.ts`; the web bundle is unchanged) and
   attaches GPUIX with the same credential, as the launched app is.
   `tauri` runs GPUIX first and then the desktop app
   (`tools/reference/tauri.ts`): a fresh Xvfb display, a throwaway HOME
   seeded with the world's four projects, the window placed at 1280x800,
   and XTEST keys and clicks. A click lands where GPUIX found the same
   target. The desktop app's text cannot be read, so it has no checks; each
   frame is grabbed once two grabs a second apart match, and the region is
   a fixed rectangle (`roiRect`). A surface can also start both clients on
   a hash route (`start`); GPUIX boots there through `GPUIX_START_HASH`.

## Statuses and scores

| Status | Meaning |
| --- | --- |
| ported | Every action and check passes in GPUIX, and the pair shows no difference a user would notice beyond font rasterization. |
| partial | The interactions work, but the pair shows visible or behavioral differences. |
| broken | An action or check that passes on the web fails in GPUIX, or GPUIX shows the wrong thing. |
| blocked | No reference exists, or a missing platform capability stops the run. Since R5 no surface is blocked. |
| pending-unit | Waits on another unit (named in the table), such as a surface GPUIX does not have yet. |
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

**How this run was made (G13, 2026-10-26).** Every row comes from one head,
949b8c16 on `gpuix/g13` (`exp/gpuix-client` at 911f2baf plus G13's
fullscreen table theme and tool fixes), and one full `bun run parity:matrix`
run of all 117 surfaces. GPUIX ran on the self-built patched addon, the
build the `.deb` ships: `bun run native:build` with the full series (zed
0001 to 0005, gpuix 0001 to 0011, series hash 7dc0722e), then
`NAPI_RS_NATIVE_LIBRARY_PATH=native/gpuix-native/build/gpuix-native.linux-x64-gnu.node`.
`bun run native:patch-check` passed 24 of 24 checks on that file. The web
client was the worktree's own `bun run build:web`. The window was active
(the harness default). Every surface ran with
`TERMUL_SERVER_BIN=tools/canvas/server-with-bundle.ts`, the webview helper
from `bun run build:webview-host`, and the FigCraft bundle that
`canvas/figcraft.pin` names (termul-v0.2.0, sha256 verified on fetch). The
full run took 44 minutes. No other unit ran; an idle V1 test server stayed
up on port 8194. The 1-minute load average, sampled every minute, had a
median of 5.6 and a peak of 8.5 on 8 cores, all of it the run's own
Chromium, lavapipe and servers. Three surfaces that failed in the full run
ran twice more, and their rows come from the first rerun (see Flakes).

**The web reference changed.** Since N3 every web reference launches with
`--font-render-hinting=slight` (`tools/shared/chromium.ts`,
`WEB_REFERENCE_ARGS`), the fontconfig default on GNOME and Ubuntu and what
desktop Chrome lays text out with. Headless Chromium's default `full`
hinting put text on whole-pixel hinted advances. G12 and every earlier run
measured against that reference, so their numbers are not comparable with
this run's. This run is the new baseline. GPUIX also gained native patch
zed/0005 (fractional line height) since G12.

**N4 chat rerun (2026-10-26).** The 10 chat surfaces ran again on
`gpuix/n4` with the series extended by zed/0006 and gpuix/0012 and 0013
(series hash 4fa19363), and once more on the `exp/gpuix-client` head
(d4786df8) with G13's addon as the before run, both with
`bun tools/matrix/run.ts --area chat`. The before run reproduced G13's
numbers to the decimal (chat.transcript 15.4/1.71 % full frame, 3.08 %
region). Every chat row on this page comes from the N4 run; the other
areas keep G13's rows. chat.table-fullscreen moved from partial to ported
(full-frame perceptual 1.01 to 0.08 %). The seven chat text checks that
failed only because native prose was not in the automation tree now pass
(gpuix/0013), and the wheel over the transcript finds its target by text
instead of the web's point.

**R5 references (2026-10-26).** The seven surfaces G13 scored as blocked
now each have a reference, rerun on `gpuix/r5` (the `exp/gpuix-client`
head 1408ef5e plus R5's harness) with the patched addon at series
4fa19363 (`bun run native:patch-check`: 32 checks pass), the worktree's own
`bun run build:web`, the shared release `termul-server` (built 2026-10-25,
the first with the host-local credential), and the desktop app built from
this checkout with `tauri.conf.dev.json`. Each ran twice; the two runs agree
within 0.01 point of perceptual mismatch on every surface (last step, full
frame then region where one is set):

| Surface | Reference | Run 1 | Run 2 | Reviewed |
| --- | --- | --- | --- | --- |
| `browser.pane` | the desktop app | 1.09 %, region 0.94 % | 1.10 %, region 0.95 % | partial |
| `ssh.workspace` | web host-local | 1.47 % | 1.47 % | partial |
| `settings.accounts-claude` | web host-local | 0.18 %, region 0.27 % | 0.19 %, region 0.27 % | partial |
| `shortcuts.desktop-keymap` | web, desktop keys bound | 2.32 % | 2.32 % | partial |
| `snapshots.page` | web on `#/snapshots` | 0.40 % | 0.40 % | partial |

Every action and check passed in both clients in both runs. Each status
comes from the PNG pairs, and each surface has one gap a user would see:

- browser.pane: the desktop app and GPUIX both run the pane in a WebKitGTK
  webview, and the reference page lands on the same pixels. GPUIX shows the
  dev-only Debug Console button beside the URL field, because the GPUIX
  bundle leaves `import.meta.env.PROD` undefined. GPUIX also does not inject
  the agentation toolbar on load, as the desktop app does.
- ssh.workspace: the sidebar section and the Hosts tab match. In the New
  host dialog GPUIX stacks Port under Address, where `grid-cols-[1fr_6rem]`
  sets them on one row.
- settings.accounts-claude: Add account and the dialog's name step match.
  The account row shows the wide-layout gap settings.provider already had.
- shortcuts.desktop-keymap: Ctrl+T, Ctrl+W, Ctrl+R, Ctrl+, and Ctrl+= do the
  same thing in both clients. The last frame shows the web zoom overflow
  that shortcuts.zoom-in already records.
- snapshots.page: GPUIX paints nothing under the header where the web shows
  the empty state (No snapshots yet, Create First Snapshot). The text is in
  the automation tree, so the check passes and only the pair shows the gap.

The remote access popover and the update toast are not blocked anymore:
the desktop app is their reference, and GPUIX does not have either surface
yet. They wait on R4 and U1 (`pending-unit`) and still score 0. The
desktop harness reaches the popover: one XTEST click on the status bar's
remote access button opens Remote Agent Access with its Enable remote
access switch.

R5 also found a product defect outside GPUIX. On its first run the web
client, as a host-local client against a fresh server, showed the error
toast 'Could not save "ssh/profiles-migrated": another device changed it
first. Try again.' The likely cause is two concurrent first host-side lists. Both
write the create-only marker. `copyStoreProfilesToHost` treats the loser's
`STORE_CAS_FAILED` as success, but the persistence layer shows the error
toast anyway (inferred from the code; not reproduced in isolation). The
matrix now seeds the hosts and the marker over a host-local socket, so no
client runs that copy.

**Where it stands.** 117 surfaces: 98 ported, 17 partial, 0 broken, 0
blocked, 2 pending-unit. The usage-weighted score is 91.0 % over all
surfaces and 91.9 % over the 115 measured ones. Unweighted, it is 91.0 %
and 92.6 %. Before R5 the score was 89.9 %, and the 92.9 % over measured
surfaces covered 110 of them. The five new references added 1.1 points,
because each surface moved from 0 to partial. By area, the composer,
terminal, git, explorer, side panel, status bar, palette, themes, dialogs
and canvas are at 100 %. The rail is at 95 %, the editor at 87.5 %, and
settings and shortcuts at 85.7 %. Snapshots is at 75 %, and chat, the
browser pane, SSH and notifications at 50 to 70 %. Remote access is at 0,
because GPUIX does not have its one surface yet.

Against G12 (88.6 % weighted, 94 ported), three surfaces moved from partial
to ported and none moved down. settings.skills, settings.shortcuts and
settings.diagnostics set their `text-xs leading-relaxed` lines 19.5 px
apart as Chromium does (zed/0005); their last-step full-frame perceptual
diff fell from 1.78, 1.40 and 1.30 % to 0.65, 0.42 and 0.51 %. Across the
110 measured surfaces the mean last-step full-frame perceptual diff fell
from 1.29 % to 1.10 %: 92 surfaces read lower, 14 within 0.05 points and 4
higher. Of the 4, terminal.split (1.02 to 1.34 %) and terminal.tab-reorder
(0.71 to 1.05 %) differ only in the Chats list, which earlier chat surfaces
fill on the shared server; G12 scored them from reruns, before that list
had grown. rail.project-list (0.95 to 1.02 %) and chat.model-selector (1.78
to 1.84 %) moved by less than 0.1 point.

- chat.table-fullscreen is ported (N4). G13 gave its fullscreen table the
  web's unscaled Streamdown cells, inline code and 44 px buttons; N4 fixed
  the three native differences left. The inline-code wash sat 6 px left
  of the web's chip because GPUI measured a line that opens with a padded
  chip from its first glyph (zed/0006), not because gpuix/0007 widened it.
  Columns now take their max-content width as flex basis (gpuix/0012), and
  the rules are `border-border` under body rows only.
- chat.transcript and chat.model-selector stay partial for one gap older
  than N4: the transcript sits 3 px higher than the web's, from the last
  reply's action row down. The bash code card now matches (body 81 px,
  card 139 px in both; the web's pre keeps a 0.55em bottom margin inside
  the body).
- chat.scroll-top stays partial: the inline table's rows are 31 px apart
  against the web's 30.6 px, and the first ordered item starts 3 px left
  (Chromium's list markers use tabular figures; the paragraph's
  proportional 1 is 3.39 px narrower). Items 2 and 3, the table's header
  labels (517, 737, 1077 px in both) and every chip wash land within 1 px.

**Ranked remaining gaps.** By the usage-weighted points each unit would win
back (the Proposed units table below), with its cause class:

1. Transcript tail spacing, needs diagnosis: +1.7 over chat.transcript and
   chat.model-selector. The last reply's copy and retry icons end 2 px
   further above the Changed files bar than the web's, and the bar sits
   1 px higher.
2. Markdown preview (E2), native override needed: +0.9. Heading letter
   spacing and list bullets differ.
3. Four chat units at +0.9 each: the inline table's 31 px row pitch and the
   tabular list markers (native override needed), the agent chip that
   truncates in the agent popover (C2, compat translator gap), Mermaid's
   missing pan, zoom and fullscreen buttons (missing GPUIX capability) and
   the plan card's ring and divider (compat translator gap).
4. Title tooltips over a modal (compat translator gap, +0.5), and the two
   Tauri-only surfaces that have a unit: the update toast (U1, native
   override needed, +0.5) and the remote access popover (R4, server route
   needed, +0.5).
5. Four units at +0.1 each: the agent registry list in settings (needs
   diagnosis), the Accounts row's wide layout and the inline code wrap in
   the MCP footnote (compat translator gaps), and the web's zoom overflow
   (needs diagnosis).
6. R5's references added three units and extended two. The browser pane's
   production flag and agentation auto-inject (+0.5), arbitrary grid
   columns (+0.3) and the snapshots empty state (+0.1) are new. The Accounts
   row layout now covers two surfaces (+0.3), and so does the web zoom
   overflow (+0.1).

**What 99 % parity requires.** Every surface now has a reference, so the
target can be measured. If every unit in the Proposed units table fixed
every surface it names, the score would be 100.0 %. Before R5 the limit
was 97.8 %, because the 2.2 points of reference-less surfaces could never
score. The score is 91.0 %, so 99 % means winning back 8 of the 9 open
points. At most one point of the 100 weight can stay open.

Five references are fair comparisons and need no special rule:

- The browser pane (1.0 of the weight) is compared with the desktop app.
  The web client has no browser tab, and both desktop shells run the page
  in a WebKitGTK webview.
- SSH (0.5) and Claude accounts (0.29) are compared with the web client
  granted the host-local capability that the launched GPUIX app has. Both
  clients render the same shared components with the same data.
- The desktop keymap (0.14) is compared with the web client pressing the
  same keys, bound as custom keys.
- The snapshots page (0.25) is compared with the web client on the same
  route.

None of these references is shipped. The WebSocket route exists only in the
harness. `GPUIX_START_HASH` is an environment flag, unset in normal use.
The custom keys are a setting that a web user can make.

The units in order of points:

1. Land the chat units first. Chat is 17 of the 100 weight and holds 6 of
   the 17 partial surfaces. The tail spacing and the four +0.9 chat units
   are worth 5.3 points together.
2. The two pending surfaces are worth 1.0: R4's remote access popover and
   U1's update toast. Each needs a GPUIX feature, and then a Tauri-driven
   step for the matrix.
3. The editor's markdown preview (+0.9), the browser pane (+0.5) and the
   title tooltips (+0.5) come next.
4. The six remaining units are each worth 0.3 or less, about 1.0
   together. That is the most that may stay open, so 99 % needs every unit
   above them as well.

Two gaps may be behavior bugs rather than cosmetic ones: the empty agent
registry list in settings, and the unpainted snapshots empty state. Diagnose
them first.

**Flakes.** A surface that differed in the full run and matched on a rerun
is recorded here and scored from its matching run. A surface that differed
in every run is a gap above, not a flake. G13 reran the three surfaces that
failed in its full run, and two that read higher than G12 (terminal.split
and terminal.tab-reorder, which matched on their full-run pairs and keep
their full-run rows). All five matched on both reruns.

| Surface | Runs that differed | What happened |
| --- | --- | --- |
| `editor.markdown` | 1 of 3 (G13) | In the full run the GPUIX click on the docs folder did not expand it: the frame shows the row's name hint and no guide.md, so the next click missed and 3 of 7 GPUIX checks failed. The reruns opened guide.md (1.21 % and 1.44 % full-frame perceptual). Not traced; the click went to the web point. |
| `composer.mention` | 1 of 3 (G13) | The web frame caught chat.queue's held `matrix hold` turn still running (a spinner on its chat card and on alpha); GPUIX, run later, showed it ended. 2.36 % full-frame perceptual against 1.27 % on both reruns. |
| `palette.app-preferences` | 1 of 3 (G13) | GPUIX painted the Interface rows in the narrow layout, each control under its text, where the web sets it beside. The reruns had the wide layout (0.36 % both times, 1.46 % in the full run). This is the container-query first frame that earlier units recorded. |
| `rail.add-menu` | 1 of 3 (G12) | In the full run the GPUIX click on New project did not open the modal; the menu stayed open. The two reruns opened it (0.57 % and 0.49 % full-frame perceptual, M3 0.57 %). Not traced. |
| `chat.send` | 1 of 3 (G12) | The web frame caught the reply still streaming (the transcript short of the bottom, with the new-message badge); GPUIX had finished. The reruns read 2.68 % both times, M3 2.98 %. |
| `terminal.split` | 3 of 8 | M3: the lost Bash click once, and GPUIX keeping focus on Terminal 1 once. G12's full run showed neither terminal focused after the split; its two reruns focused the moved Terminal 2, as the web does. G13's full run focused Terminal 2 in both. |
| `terminal.tab-reorder` | 2 of 7 | M3: the Bash click replayed the web point before GPUIX had painted the New tab menu, fixed by clicking Bash by its text. G12's full run read 1.10 % against M3's 0.57 % with both tabs reordered; the reruns read 0.71 % twice. |
| `git.stage` | 1 of 3 (M3) | The GPUIX Stage changes click also opened README.md's working-tree diff. G12 traced it to compat's gesture grouping: GPUIX delivers one click to the button and then to the row, one handler run apart (11 ms on a quiet host), and a delivery more than 100 ms after the first started a new gesture that RowAction's stopPropagation no longer covered. A delivery now belongs to the gesture of the press at its point. `tools/clickloss --targets stage` passed 40 of 40 quiet and 20 of 20 on two loaded cores before the fix, so there is no live repro; a unit test with a 150 ms handler fails before it. |
| `rail.project-settings` | 1 of 2 (M3) | GPUIX painted the gear's "Project settings" title tooltip over the modal; the rerun showed none. |
| `explorer.expand` | 1 of 2 (M3) | The GPUIX frame caught the row name hint that FileTreeNode shows after 900 ms of hover, and the web frame did not. Both clients show the hint, so this is timing; the row stays ported. |

The other flakes that earlier units recorded (the terminal limit, C13's
automation timeout, `composer.attach` missing its file) did not show in
this run.

**Earlier units, in short.** These diagnoses still hold. Their numbers are
superseded by the run above.

- G6 made a focused text field paint its `focus-visible:` style in the frame
  it gains focus (native patch gpuix/0009), added `divide-x` and `divide-y`
  to the style layer, and traced the Accounts skeleton and the composer
  after a project switch to the frame grab racing a slower GPUIX. The steps
  now wait for the loaded state, and every check records its wait (`ms` in
  `results.json`).
- G7 attached files through the real GTK portal chooser (patch gpuix/0008),
  fixed the empty queued-prompt transcript (a lone `<markdown>` row laid out
  at its 0 px fit width), and added task-list checkboxes, the streaming
  caret and the table fullscreen view.
- I4 made the composer's native textarea and key-capture div report focus,
  so the card paints its focus border and inset ring.
- G8 stopped the launcher sending an early prompt to the default agent
  (`tools/matrix/agent-pick.ts`), showed that `text-wrap: pretty` changes no
  transcript line break (`tools/chat/wrap-probe.ts`), and sized table rows
  with patch gpuix/0010.
- G9 added `zIndex` (patch gpuix/0011) and compat stacking
  (`src/compat/stacking.ts`), so the composer card and the status bar stack
  as on the web, and baked `rotate-*` into icons. A `zIndex` layer paints
  without its ancestors' opacity, and rotation reaches icons only.
- G10 drew Mermaid through the webview helper with the web's mermaid
  11.16.0 and kept the boot launcher mounted across the first project
  commit. G11 made the composer pill name the chat's agent after a boot
  reopen.
- G12 ran the whole matrix on c033eb66 against the full-hinting reference
  (88.6 % weighted, 94 ported). It made a press on content that takes no
  focus blur the focused field, as Chromium does (`compat/window-press.ts`),
  sat an inline label alone on a line on its parent's strut
  (`compat/children.ts`), and gave the table fullscreen layer
  `LAYER.dialog`, with a test that fails on any `<anchored>` without a
  priority.
- N3 traced the "1 % wider" prose and the 6 to 7 px table column offset to
  headless Chromium's full hinting, moved the web reference to slight
  hinting, and added native patch zed/0005 for fractional line height
  (`tools/native/typo-check.ts`, [native-patches.md](./native-patches.md)).
- G13 gave the fullscreen table the web's unscaled cells, chips and 44 px
  buttons, made `tools/chat/check.ts` wait for the rows it reads (a prompt
  sent before the scene's chat started was dropped), and made the GTK file
  chooser helper skip windows that vanish while it walks the tree.
- M3 ran the whole matrix on one head (a1661ef6), found
  the table fullscreen layer regression and the composer focus after
  layout shortcuts, and made the terminal surfaces click Bash by its text.

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

**How far to trust a row.** A `tauri` row's reference has no checks: the
desktop app's text cannot be read, so its frames are the whole record, and
a click there lands where GPUIX found the target. Read those pairs whole.
GPUIX text checks read the automation tree.
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
- The mobile layout and what's new.

<!-- matrix:begin (generated by `bun run parity:matrix`; edit tools/matrix/review.ts, not this block) -->

Surfaces: 117 (ported 98, partial 17, broken 0, blocked 0, unverified 0, pending-unit 2).

| Score | All surfaces (pending, blocked and unverified count 0) | Measured surfaces only |
| --- | ---: | ---: |
| Unweighted | 91.0% | 92.6% |
| Usage-weighted | 91.0% | 91.9% |

### By area

| Area | Weight | Surfaces | Ported | Partial | Broken | Blocked, pending or unverified | Area score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chat | 17 | 10 | 4 | 6 | 0 | 0 | 70.0% |
| composer | 14 | 3 | 3 | 0 | 0 | 0 | 100.0% |
| terminal | 14 | 7 | 7 | 0 | 0 | 0 | 100.0% |
| rail | 9 | 10 | 9 | 1 | 0 | 0 | 95.0% |
| git | 9 | 9 | 9 | 0 | 0 | 0 | 100.0% |
| explorer | 7 | 4 | 4 | 0 | 0 | 0 | 100.0% |
| editor | 7 | 4 | 3 | 1 | 0 | 0 | 87.5% |
| side-panel | 5 | 5 | 5 | 0 | 0 | 0 | 100.0% |
| settings | 4 | 14 | 10 | 4 | 0 | 0 | 85.7% |
| statusbar | 3 | 3 | 3 | 0 | 0 | 0 | 100.0% |
| palette | 3 | 11 | 11 | 0 | 0 | 0 | 100.0% |
| theme | 2 | 21 | 21 | 0 | 0 | 0 | 100.0% |
| shortcuts | 1 | 7 | 5 | 2 | 0 | 0 | 85.7% |
| dialogs | 1 | 1 | 1 | 0 | 0 | 0 | 100.0% |
| browser | 1 | 1 | 0 | 1 | 0 | 0 | 50.0% |
| notifications | 1 | 2 | 1 | 0 | 0 | 1 | 50.0% |
| remote | 0.5 | 1 | 0 | 0 | 0 | 1 | 0.0% |
| snapshots | 0.5 | 2 | 1 | 1 | 0 | 0 | 75.0% |
| canvas | 0.5 | 1 | 1 | 0 | 0 | 0 | 100.0% |
| ssh | 0.5 | 1 | 0 | 1 | 0 | 0 | 50.0% |

### Ranked gaps

Rank is the reviewed impact (1 to 3) times the area weight.

| # | Surface | Status | Root cause class | Proposed unit | Rank | What differs |
| ---: | --- | --- | --- | --- | ---: | --- |
| 1 | `chat.transcript` | partial | needs diagnosis | transcript tail spacing, 3 px (unassigned) | 17 | The transcript, code card, task list, Worked for row and Changed files bar all render. The bash code card's body is 81 px between its borders in both, and the card 139 px tall in both (N4: the web's `.chat-streamdown pre` keeps a 0.55em bottom margin inside the body; it was 73 px). The task list lands on the web's columns (bullet 527, checkbox 547, text 565 px in both). The transcript sits 3 px higher than the web's, from the last reply down: its copy and retry icons end 2 px further above the Changed files bar (545 against 548 px, the bar at 602 against 603 px). It predates N4: the user bubble ends at 387 against 390 px on the exp/gpuix-client head too. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently. Inline-code washes start where the web's chips do (N4: native patch zed/0006 measures a line that opens with a padded chip from the line's origin; GPUI had measured it from the first glyph, so every wash on such a line sat its padding left of the glyphs). On the transcript table the chips' washes start at 516 and 736 px against the web's 516 and 737 px (512 and 734 before N4). |
| 2 | `chat.scroll-top` | partial | native override needed | table row pitch and tabular list markers (unassigned) | 17 | One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button. The table card has the web's copy, download and fullscreen buttons (G7). Its header labels start at 517, 737 and 1077 px in both (N4: cells take their max-content width as flex basis, gpuix/0012; 739 before, and the 6 and 7 px G12 measured were headless Chromium's hinted advances, N3). Rows are 31 px against the web's 30.6 px, with the semibold header on the web's muted fill (G8 patch gpuix/0010-table-cell-metrics: 8 by 4.8 px cells on a 20 px line; before it rows were 32 px with no header fill). The table card's Copy, Download and View fullscreen icons sit at the web's x (1161, 1190 and 1217 px, G13). Its rules are the web's `border` colour (rgb 36; the text at 10 %, rgb 33, before N4's gpuix/0012). An ordered item sets its number inline, as Streamdown's `list-inside` marker does (N4: a one-paragraph item paints as a paragraph led by its number), so its first chip's wash starts at 542, 545 and 544 px against the web's 545 px on all three items (550 before). The first item is 3 px short: Chromium draws list markers with tabular figures, and Inter's proportional 1 is 3.39 px narrower at 14 px (2 and 3 within 0.6 px). Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently. Inline-code washes start where the web's chips do (N4: native patch zed/0006 measures a line that opens with a padded chip from the line's origin; GPUI had measured it from the first glyph, so every wash on such a line sat its padding left of the glyphs). On the transcript table the chips' washes start at 516 and 736 px against the web's 516 and 737 px (512 and 734 before N4). |
| 3 | `chat.agent-launcher` | partial | compat translator gap | C2 menus and popovers | 17 | The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. In GPUIX the agent chip is narrower and truncates to "Chat Scen…", with the more button beside it. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| 4 | `chat.send` | partial | missing GPUIX capability | mermaid pan, zoom and fullscreen (unassigned) | 17 | Typing and Enter start a chat and the scripted reply streams in both. The chat starts on the device's picked agent even when Enter comes before the launcher has restored that pick: the send waits for the pick (G8 AGENT-PICK; `tools/matrix/agent-pick.ts` sends the moment the composer appears and lands 4 of 4 web and 4 of 4 GPUIX chats on the picked agent, 2 of 4 and 1 of 4 before). The mermaid diagram is drawn as on the web (G10 MERMAID): the webview helper renders it with the web's mermaid 11.16.0 and config and the card fits the PNG to its frame, 714 by 191 px against the web's 714 by 195 px (WebKit measures the monospace labels 2 % wider). The pan and zoom buttons and the fullscreen action are missing; Download saves the source. The boot launcher stays mounted across the first project commit (G10 BOOT-REMOUNT, re-landed in G11), and the composer pill names the chat's agent: the c-reply step checks "Chat Scenario Agent" inside the pill. Before G11 LABEL a boot reopen adopting the host's agent took the reuse key from the agent the new chat ran on, and the pill read "Agent" in 2 of 5 GPUIX runs; with the fix 6 of 6 GPUIX and 6 of 6 web runs pass. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| 5 | `chat.model-selector` | partial | needs diagnosis | transcript tail spacing, 3 px (unassigned) | 17 | The running chat shows the agent chip and composer like the web. The bash code card's body is 81 px between its borders in both, and the card 139 px tall in both (N4: the web's `.chat-streamdown pre` keeps a 0.55em bottom margin inside the body; it was 73 px). The task list lands on the web's columns (bullet 527, checkbox 547, text 565 px in both). The transcript sits 3 px higher than the web's, from the last reply down: its copy and retry icons end 2 px further above the Changed files bar (545 against 548 px, the bar at 602 against 603 px). It predates N4: the user bubble ends at 387 against 390 px on the exp/gpuix-client head too. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently. Inline-code washes start where the web's chips do (N4: native patch zed/0006 measures a line that opens with a padded chip from the line's origin; GPUI had measured it from the first glyph, so every wash on such a line sat its padding left of the glyphs). On the transcript table the chips' washes start at 516 and 736 px against the web's 516 and 737 px (512 and 734 before N4). |
| 6 | `chat.plan` | partial | compat translator gap | plan card ring (unassigned) | 17 | The pinned Plan panel and the inline plan card show the same three entries, Medium chips, the struck-through finished entry and the 1/3 count, and the short transcript starts at the top in both. The card frames differ. The web card is `bg-card/30` with a `ring-1 ring-border/50` hairline and a divider under its header; GPUIX fills it lighter, with no ring and no divider. The collapse chevron points up in both (G9: compat lifts `rotate-180` and the icon bakes the turn into its SVG). The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| 7 | `rail.add-menu` | partial | compat translator gap | title tooltips (unassigned) | 9 | Clicking + opens the New project / New folder group menu and New project opens the Create New Project modal with the same fields in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). GPUIX paints the + button's "Add project or folder group" title tooltip above the modal and its scrim; the web shows none. The footnote wraps "memory-only" at a different word. |
| 8 | `settings.ai-agents` | partial | needs diagnosis | agent registry list in settings (unassigned) | 8 | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The agents list shows No agents match "" while the web lists the registry (Agoragentic first). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). A row's label sits on the web's 24 px line (G12: the inline `<label>` alone on a line of its block parent gets the parent's strut, so the text column is 45 px against the web's 45.5 and the row 69 against 70; it was 41 and 65, with the label 3 px high). The scrim dims and blurs the page behind it as on the web (N2). |
| 9 | `editor.markdown` | partial | native override needed | E2 markdown preview parity | 7 | Preview has the "On this page" outline (G4) and the heading and paragraph rows land on the web rows; heading sizes follow BlockNote (48/32 px). The heading has no -0.018em letter spacing (GPUIX has none), so "Alpha guide" is about 10 px wider, and the list bullets are larger and brighter, with the items set further right. The tab reads "guide.md" in full at the web width (C15 fixed in G5). A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. |
| 10 | `settings.provider` | partial | compat translator gap | account row wide layout (unassigned) | 4 | Accounts lists the Default account, Signed in, with "Usage is not available right now", Try again and the `termul-server claude account` hint in both. The skeleton M2 saw was the frame grab racing the list: the step checked for the nav label it had just clicked. It now waits for "1 account", which GPUIX painted 1871 ms after the click and the web 158 ms after (G6 run). GPUIX puts the usage note under the account name, where the web sets it beside the name in the wide layout. The scrim dims and blurs the page behind it as on the web (N2). |
| 11 | `settings.mcp-servers` | partial | compat translator gap | inline code wrap in settings text (unassigned) | 4 | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). The inline code in the footnote breaks onto its own line. |
| 12 | `settings.accounts-claude` | partial | compat translator gap | account row wide layout (unassigned) | 4 | Reference (R5): the web client with the host-local credential, and GPUIX attached with the same credential. Both show Add account, the Keep work and personal apart card, and the Add a Claude account dialog with the name typed. The run stops before Continue, which would start a real claude.ai sign-in on the host. The Accounts section has the gap settings.provider has: GPUIX puts the usage note under the account name, and the row menu on a line of its own, where the web sets them beside the name. |
| 13 | `shortcuts.zoom-in` | partial | needs diagnosis | web zoom overflow (unassigned) | 1 | Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4's keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both). The zoomed web page runs past the window bottom, so its status bar is cut off and the dashboard heading sits 25 px lower; GPUIX keeps the status bar in the window. After the shortcut both composers rest unfocused (G12). The step first clicks the rail's Projects label, and the web blurs the composer there: Chromium's default action for a press no listener prevented moves focus to body when the pressed content takes none. GPUIX now does the same (`compat/window-press.ts`), where GPUI had kept the composer focused. |
| 14 | `shortcuts.desktop-keymap` | partial | needs diagnosis | web zoom overflow (unassigned) | 1 | Reference (R5): the web client with the desktop table bound as custom keys, as a web user can set them in Keyboard shortcuts; GPUIX presses the same keys with its default (desktop) keymap. Headless Chromium hands Ctrl+T, Ctrl+W and Ctrl+R to the page. Every key does the same in both: Ctrl+T shows the agent launcher over Terminal 1 and a second Ctrl+T hides it, Ctrl+W asks to close Terminal 1 and Close removes it, Ctrl+R opens Command History, Ctrl+, opens Preferences and Ctrl+= zooms in. The last frame differs as in shortcuts.zoom-in: the zoomed web page runs past the window bottom, and GPUIX keeps the status bar in the window. |
| 15 | `browser.pane` | partial | missing GPUIX capability | browser pane production flag and agentation auto-inject (unassigned) | 1 | Reference (R5): the desktop app (Tauri on WebKitGTK) built from the same checkout, driven with X input at the same 1280x800 (`tools/reference/tauri.ts`). Ctrl+Shift+N opens a browser tab in both and the typed URL loads the local reference page. Both panes are WebKitGTK webviews, and the page lands on the same pixels; the pane region reads 0.94 % perceptual. GPUIX shows the Debug Console button beside the URL field. BrowserControls shows it only when `import.meta.env.PROD` is false, and the GPUIX bundle does not define it; the desktop app's and the web's production builds hide it. The desktop app injects its agentation toolbar into every page it loads (browser_tab_manager.rs, enabled by default), a round button at the page's bottom right; the GPUIX helper injects it only on a click. The desktop tab still reads 127.0.0.1:8289 after the page loaded; GPUIX names the tab after the page title. The desktop app draws its own window buttons at the right of the tab bar; GPUIX leaves them to the window manager. The rail differs outside the pane: the desktop app is host-local (an SSH section) and has no seeded chat. |
| 16 | `update.toast` | pending-unit | native override needed | U1 GPUIX updater and what's new | 1 | GPUIX has neither the update toast nor the what's new modal; App.tsx renders both only under isTauriContext(). The reference is the desktop app (`tools/reference/tauri.ts`): the toast against a release feed, the modal after a version change. The packaged GPUIX app has a command-line check, `termul-gpuix --check-update`. |
| 17 | `snapshots.page` | partial | needs diagnosis | snapshots empty state (unassigned) | 1 | Reference (R5): both clients start on #/snapshots, the web by URL and GPUIX through GPUIX_START_HASH; no desktop shell links to the route (only the mobile drawer). The header, Create New Snapshot and the Create Snapshot dialog match. GPUIX paints nothing under the header where the web shows the empty state: the camera, No snapshots yet and Create First Snapshot. The text is in the automation tree, so the check passes; the block is not painted. |
| 18 | `remote.access-popover` | pending-unit | server route needed | R4 desktop host role over the server | 0.5 | GPUIX has no remote access popover yet; StatusBar renders it only under isTauriContext(). The reference is the desktop app (`tools/reference/tauri.ts`), whose status bar has the button. |
| 19 | `ssh.workspace` | partial | compat translator gap | arbitrary grid columns (unassigned) | 0.5 | Reference (R5): the web client with the host-local credential added to its handshake, and GPUIX attached with the same credential, as the launched app is. Both list the two seeded hosts in the sidebar SSH section, with the build-box favourite first. The Hosts tab matches: the search field, Import and New host, and the Favorites and Servers groups with the same rows. The New host dialog differs. The web sets Address and Port on one row (`grid-cols-[1fr_6rem]`); GPUIX stacks Port under Address, so the Organize section is scrolled out of the dialog. |

### Proposed units

Each unit with the surfaces its gaps name. Gain is the usage-weighted score (all surfaces) the matrix would report if every one of those surfaces became ported, everything else unchanged.

| # | Unit | Root cause class | Surfaces | Summed rank | Gain |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | transcript tail spacing, 3 px (unassigned) | needs diagnosis | 2 | 34 | +1.7 |
| 2 | table row pitch and tabular list markers (unassigned) | native override needed | 1 | 17 | +0.9 |
| 3 | C2 menus and popovers | compat translator gap | 1 | 17 | +0.9 |
| 4 | mermaid pan, zoom and fullscreen (unassigned) | missing GPUIX capability | 1 | 17 | +0.9 |
| 5 | plan card ring (unassigned) | compat translator gap | 1 | 17 | +0.9 |
| 6 | title tooltips (unassigned) | compat translator gap | 1 | 9 | +0.5 |
| 7 | agent registry list in settings (unassigned) | needs diagnosis | 1 | 8 | +0.1 |
| 8 | account row wide layout (unassigned) | compat translator gap | 2 | 8 | +0.3 |
| 9 | E2 markdown preview parity | native override needed | 1 | 7 | +0.9 |
| 10 | inline code wrap in settings text (unassigned) | compat translator gap | 1 | 4 | +0.1 |
| 11 | web zoom overflow (unassigned) | needs diagnosis | 2 | 2 | +0.1 |
| 12 | browser pane production flag and agentation auto-inject (unassigned) | missing GPUIX capability | 1 | 1 | +0.5 |
| 13 | U1 GPUIX updater and what's new | native override needed | 1 | 1 | +0.5 |
| 14 | snapshots empty state (unassigned) | needs diagnosis | 1 | 1 | +0.1 |
| 15 | R4 desktop host role over the server | server route needed | 1 | 0.5 | +0.5 |
| 16 | arbitrary grid columns (unassigned) | compat translator gap | 1 | 0.5 | +0.3 |

If every listed unit landed and fixed its surfaces, the usage-weighted score would be 100.0%.

### References

Every surface is compared against the DOM web client in Chromium except these (`Reference` in `types.ts`).

| Surface | Reference | Status |
| --- | --- | --- |
| `remote.access-popover` | tauri | pending-unit |
| `browser.pane` | tauri | partial |
| `ssh.workspace` | web-host-local | partial |
| `settings.accounts-claude` | web-host-local | partial |
| `update.toast` | tauri | pending-unit |

### Surfaces

The Reference and GPUIX columns count passed actions plus checks over the total. The reference is the web client unless the cell names another: `web host-local` is the web client with the host-local credential, `tauri` the desktop app, which runs the actions but has no checks because its text cannot be read. Mismatch is exact / perceptual for the last step: the full 1280x800 frame, and the region the surface names (measured in the web client, or a fixed rectangle for the desktop app, cropped from both frames).

| Surface | Area | Status | Auto | Reference | GPUIX | Full mismatch | Region mismatch | Differences seen |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `rail.project-list` Project list and switching | rail | ported | ported | 10/10 | 10/10 | 5.8% / 1.02% | 3.2% / 0.61% | Same layout and order; switching to beta works by click in both (H1 fixed the lost clicks: `bun tools/clickloss/run.ts --trials 20` switched projects 60/60 through automation and XTEST). After the switch the beta composer shows Chat Scenario Agent in both. GPUIX gets there later: the agent chip appeared 967 ms (rail) and 586 ms (palette) after the switch in GPUIX and within 82 ms on the web (G6 run; the step now waits for it, so the frames match). The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `rail.project-menu` Project context menu | rail | ported | ported | 3/3 | 3/3 | 7.0% / 1.04% | 6.9% / 0.68% | Right-click opens the project menu with the same rows, icons, submenu chevrons and red Delete, at the same place (G3: Radix opens a context menu 2 px right of the pointer). Row labels sit where the web puts them (G5: the " Label" text in a row's nested {icon}{children}{after} array is trimmed like any flex text run; it had kept its leading space, 3 px). Under the open menu GPUIX keeps the hovered beta row's gear and shortcut; the web hides them, since a modal Radix menu turns pointer events off on the page. |
| `rail.project-rename` Rename a project | rail | ported | ported | 8/8 | 8/8 | 6.1% / 1.02% | 3.5% / 0.73% | Rename from the context menu edits the row in place and Enter saves gamma-renamed in both. |
| `rail.project-remove` Remove a project | rail | ported | ported | 6/6 | 6/6 | 6.0% / 0.99% |  | Delete from the context menu asks for confirmation and removes delta in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). The workspace status bar stays sharp above the confirm scrim, as on the web, where ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling (G9: compat gives the fixed overlay its z-index as its `<anchored>` priority, and native patch gpuix/0011 paints the `relative z-50` bar in the same deferred pass, after it in tree order; status-bar text 75 against the web's 72, dimmed to 11 before). |
| `rail.project-colour` Project colour picker | rail | ported | ported | 4/4 | 4/4 | 6.8% / 0.99% |  | Change Color opens the Select Color popover with the same nine swatches and the current one ringed. |
| `rail.project-reorder` Reorder projects by drag | rail | ported | ported | 4/4 | 4/4 | 6.2% / 1.00% | 3.6% / 0.63% | Dragging gamma onto alpha reorders the list to alpha, gamma, beta in both (C3 fixed in G3: the framer-motion shim drives Reorder from pointer moves with framer's one-neighbour-per-move rule). The dragged row does not follow the pointer in GPUIX, which has no transforms; the list reorders live under it. After the drop both clients stay on alpha and paint alpha and gamma in their hover state (gear and Ctrl+1/Ctrl+2), with the action strip's fade over alpha's +4 -1 diff stat. |
| `rail.add-menu` Add project menu and new project modal | rail | partial | ported | 5/5 | 5/5 | 78.8% / 0.33% |  | Clicking + opens the New project / New folder group menu and New project opens the Create New Project modal with the same fields in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). GPUIX paints the + button's "Add project or folder group" title tooltip above the modal and its scrim; the web shows none. The footnote wraps "memory-only" at a different word. |
| `rail.collapse` Collapse and expand the rail | rail | ported | ported | 3/3 | 3/3 | 6.2% / 0.85% |  | The collapsed rail matches: icons, project letters, Changes badge, and the Open canvas pencil under Search (G6: the action column is `flex-1` above an `mt-auto` footer, and the footer's auto-margin wrapper grew too and took half the free space, so the column clipped the pencil; a column now holds the wrapper back beside a growing sibling, as a row did). The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `rail.project-settings` Project settings modal | rail | ported | ported | 5/5 | 5/5 | 30.8% / 0.14% |  | Clicking the gear opens Project settings with General and the same fields in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). H1 fixed the lost gear click: compat keeps an element hovered while a blocking box inside it is hovered (`src/compat/hover.ts`); `bun tools/clickloss/run.ts --trials 20` opened the modal 60/60 through automation and XTEST. |
| `side.chats` Chats tab with a chat card | side-panel | ported | ported | 2/2 | 2/2 | 6.2% / 1.13% | 1.4% / 0.47% | The card title, agent, branch and age match; with more chats the cards stack one per row (G2 native ChatsList). |
| `side.chats-search` Search chats | side-panel | ported | ported | 7/7 | 7/7 | 6.0% / 0.99% |  | Filtering to no match and back matches, including the No matches. text. |
| `side.chat-card-menu` Chat card context menu | side-panel | ported | ported | 5/5 | 5/5 | 7.2% / 1.13% |  | Right-click on a chat card opens the same five-row menu with Delete Chat in red. |
| `side.workspace-switcher` Workspace (worktree) switcher | side-panel | ported | ported | 3/3 | 3/3 | 7.4% / 0.94% |  | The Working copies popover matches; GPUIX omits the small terminal glyph on the web row hover. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| `side.hide` Hide and show the side panel | side-panel | ported | ported | 3/3 | 3/3 | 5.7% / 0.80% |  | Side panel hides; the expand chevron sits in the same place. |
| `explorer.tree` File tree | explorer | ported | ported | 6/6 | 6/6 | 6.1% / 0.98% |  | Tree, git colours and status letters match. |
| `explorer.expand` Expand a folder | explorer | ported | ported | 6/6 | 6/6 | 6.3% / 1.00% |  | Clicking src expands it to app.ts and utils.ts in both. Both clients show the row name hint FileTreeNode raises after 900 ms of hover, so a frame catches it or not by timing: in M3 the full run caught it in GPUIX only and the rerun in neither. |
| `explorer.context-menu` File context menu | explorer | ported | ported | 6/6 | 6/6 | 6.8% / 1.14% |  | Right-click on README.md opens the same file menu with Delete in red. |
| `explorer.drag` Drag a file from the tree into the pane to open it | explorer | ported | broken | 7/7 | 6/7 | 4.3% / 0.47% |  | Dragging notes.txt from the tree into the pane opens it in an editor tab in both (D1 compat drag and drop). |
| `editor.code` Code editor (CodeMirror) on a TypeScript file | editor | ported | broken | 6/6 | 5/6 | 4.1% / 0.68% |  | The native editor (E1) paints the same highlighted text, line numbers and active line; the text checks fail only because native text is painted inside GPUI and is not in the automation tree. |
| `editor.code-edit` Type into the code editor | editor | ported | broken | 9/9 | 7/9 | 4.0% / 0.69% |  | Click, End and typing put "// edited" on line 5 in both; the dirty dot shows on the tab. Same tree-text caveat as editor.code. |
| `editor.markdown` Markdown (BlockNote) editor | editor | partial | ported | 7/7 | 7/7 | 4.0% / 1.21% |  | Preview has the "On this page" outline (G4) and the heading and paragraph rows land on the web rows; heading sizes follow BlockNote (48/32 px). The heading has no -0.018em letter spacing (GPUIX has none), so "Alpha guide" is about 10 px wider, and the list bullets are larger and brighter, with the items set further right. The tab reads "guide.md" in full at the web width (C15 fixed in G5). A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. |
| `editor.tabs` Two editor tabs and switching | editor | ported | broken | 8/8 | 6/8 | 3.4% / 0.90% |  | Switching tabs works; the README preview matches the web, outline included. The tabs read README.md and app.ts in full at the web widths (C15 fixed in G5). The text check fails only because natively painted text is not in the automation tree. |
| `git.changes` Changes panel: staged, unstaged, untracked | git | ported | ported | 5/5 | 5/5 | 9.4% / 1.22% |  | Sections, rows, counts and history footer match, and the Amend last commit checkbox draws as the Chromium box (C5, G3). The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.amend` Amend last commit: the label and the box toggle it | git | ported | ported | 9/9 | 9/9 | 9.4% / 1.22% |  | Clicking the Amend last commit label checks the box and the button reads Amend commit with the last message filled in; clicking the box clears it, in both. The box, its check and its colours are sampled from Chromium. The web frames show the box in its hover colour because the pointer rests on it; GPUIX automation clicks without moving the pointer. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.diff` Diff view of an unstaged file | git | ported | ported | 5/5 | 5/5 | 57.8% / 1.24% |  | Inline diff, hunk header and STAGE HUNK match closely. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.stage` Stage a file | git | ported | ported | 5/5 | 5/5 | 9.4% / 1.22% |  | Staging README.md moves it to Staged 2 in both. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). In 1 of 3 M3 runs the GPUIX click on the row's Stage changes button also opened README.md's working-tree diff. G12 traced it to compat's gesture grouping: GPUIX delivers the click to the button and then to the row, one handler run apart (11 ms on a quiet host), and deliveries more than 100 ms after the first started a new gesture, so a slow Stage handler let the row's delivery past RowAction's stopPropagation. A delivery now belongs to the gesture of the press at its point until the next press (a unit test with a 150 ms handler fails before). `tools/clickloss --targets stage` did not reproduce it live (40 of 40 quiet, 20 of 20 on two loaded cores before; 40 of 40 after). |
| `git.unstage` Unstage a file | git | ported | ported | 5/5 | 5/5 | 10.0% / 1.17% |  | Unstaging app.ts moves it to Changes in both. The commit footer below the description field lines up with the web (G5: a textarea in a block container gets the line box's strut descent under it, 6 px, as CSS inline-block does). |
| `git.discard` Discard a change (confirm dialog) | git | ported | ported | 5/5 | 5/5 | 88.1% / 0.27% |  | The confirm dialog matches. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). The workspace status bar stays sharp above the confirm scrim, as on the web, where ConfirmDialog is an inline `fixed z-50` overlay and StatusBar a later `relative z-50` sibling (G9: compat gives the fixed overlay its z-index as its `<anchored>` priority, and native patch gpuix/0011 paints the `relative z-50` bar in the same deferred pass, after it in tree order; status-bar text 75 against the web's 72, dimmed to 11 before). |
| `git.commit` Commit staged changes | git | ported | ported | 7/7 | 7/7 | 10.0% / 1.21% |  | The commit lands (4 commits, bump version) in both. The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual. |
| `git.branch-picker` Branch picker | git | ported | ported | 3/3 | 3/3 | 7.2% / 1.13% |  | Branch popover, Local group, feature/login and Create branch row match. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| `git.worktree-create` Working copies switcher: search or create a worktree | git | ported | ported | 5/5 | 5/5 | 7.4% / 0.85% |  | Typing a new name shows No matching working copies and Create worktree feat-matrix in both. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| `chat.transcript` Open a chat: transcript, tool cards, changed files | chat | partial | partial | 5/5 | 5/5 | 15.2% / 1.72% | 18.2% / 3.11% | The transcript, code card, task list, Worked for row and Changed files bar all render. The bash code card's body is 81 px between its borders in both, and the card 139 px tall in both (N4: the web's `.chat-streamdown pre` keeps a 0.55em bottom margin inside the body; it was 73 px). The task list lands on the web's columns (bullet 527, checkbox 547, text 565 px in both). The transcript sits 3 px higher than the web's, from the last reply down: its copy and retry icons end 2 px further above the Changed files bar (545 against 548 px, the bar at 602 against 603 px). It predates N4: the user bubble ends at 387 against 390 px on the exp/gpuix-client head too. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently. Inline-code washes start where the web's chips do (N4: native patch zed/0006 measures a line that opens with a padded chip from the line's origin; GPUI had measured it from the first glyph, so every wash on such a line sat its padding left of the glyphs). On the transcript table the chips' washes start at 516 and 736 px against the web's 516 and 737 px (512 and 734 before N4). |
| `chat.scroll-top` Transcript scrolled to the first turn | chat | partial | partial | 7/7 | 7/7 | 17.9% / 2.40% | 24.6% / 4.74% | One wheel event of -20000 px scrolls both to the first turn and shows the jump-to-latest button. The table card has the web's copy, download and fullscreen buttons (G7). Its header labels start at 517, 737 and 1077 px in both (N4: cells take their max-content width as flex basis, gpuix/0012; 739 before, and the 6 and 7 px G12 measured were headless Chromium's hinted advances, N3). Rows are 31 px against the web's 30.6 px, with the semibold header on the web's muted fill (G8 patch gpuix/0010-table-cell-metrics: 8 by 4.8 px cells on a 20 px line; before it rows were 32 px with no header fill). The table card's Copy, Download and View fullscreen icons sit at the web's x (1161, 1190 and 1217 px, G13). Its rules are the web's `border` colour (rgb 36; the text at 10 %, rgb 33, before N4's gpuix/0012). An ordered item sets its number inline, as Streamdown's `list-inside` marker does (N4: a one-paragraph item paints as a paragraph led by its number), so its first chip's wash starts at 542, 545 and 544 px against the web's 545 px on all three items (550 before). The first item is 3 px short: Chromium draws list markers with tabular figures, and Inter's proportional 1 is 3.39 px narrower at 14 px (2 and 3 within 0.6 px). Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently. Inline-code washes start where the web's chips do (N4: native patch zed/0006 measures a line that opens with a padded chip from the line's origin; GPUI had measured it from the first glyph, so every wash on such a line sat its padding left of the glyphs). On the transcript table the chips' washes start at 516 and 736 px against the web's 516 and 737 px (512 and 734 before N4). |
| `chat.table-fullscreen` Table card fullscreen view | chat | ported | ported | 8/8 | 8/8 | 5.6% / 0.08% |  | View fullscreen fills the window with the table under a copy, download and exit toolbar in both (G7). The view paints over the chat composer card and the status bar, as on the web (G12: its `<anchored>` layer takes `LAYER.dialog`; with no priority it had sorted at 0 under the composer's `relative z-10` and the bar's `z-50` since gpuix/0011, 1.28 % full-frame perceptual in M3, 1.01 % after). A test fails when any `<anchored>` in apps/gpuix/src names no priority. The web portals the view outside `.chat-streamdown`, so Streamdown's utilities apply unscaled (`tools/chat/table-probe.ts`). G13 gives the fullscreen `<markdown>` its own theme from `TableCard.tsx`: 16 by 8 px cells on a 20 px line, the `bg-muted/80` header, and 14 px inline code on `bg-muted` with 6 px side padding. Copy, Download and Exit are 44 px squares 4 px apart at x 1117, 1165 and 1213 in both (they were 24 px Copy and Download), and rows are 37 px apart in both (31 before). The toolbar crop's perceptual diff fell from 1.03 to 0.26 %. N4 closed the three native differences G13 left: the inline-code washes start at the web's x (zed/0006; they sat 6 px left, because GPUI measured a line that opens with a padded chip from its first glyph), the columns share the width as CSS auto layout does (gpuix/0012: max-content as flex basis; columns 2 and 3 started 2 px right), and the rules are `border-border` (rgb 36) under body rows only, with no rule under the header (gpuix/0012 `tableRule` and `mdTableHeaderRule: 0`). The rules sit on rows 86, 159, 196, 233 and 270 in both frames; full-frame perceptual 0.08 % (1.01 % before). |
| `chat.new-chat` New chat button | chat | ported | ported | 3/3 | 3/3 | 47.1% / 0.88% |  | New chat opens the launcher composer in place. |
| `chat.agent-launcher` Agent launcher menu | chat | partial | ported | 3/3 | 3/3 | 7.2% / 1.16% |  | The agent and model popover opens above the pill in both, with the search field, the agent chip and This agent gives no model choice. In GPUIX the agent chip is narrower and truncates to "Chat Scen…", with the more button beside it. The popover's search band turns its hairline `ring` while the field has focus, as on the web (G6: a native field's focus bubbles to its compat ancestors, and the ui Box tracks `focus-within:`). |
| `chat.send` Send a prompt from the dashboard and stream the reply | chat | partial | partial | 8/8 | 8/8 | 20.4% / 5.51% |  | Typing and Enter start a chat and the scripted reply streams in both. The chat starts on the device's picked agent even when Enter comes before the launcher has restored that pick: the send waits for the pick (G8 AGENT-PICK; `tools/matrix/agent-pick.ts` sends the moment the composer appears and lands 4 of 4 web and 4 of 4 GPUIX chats on the picked agent, 2 of 4 and 1 of 4 before). The mermaid diagram is drawn as on the web (G10 MERMAID): the webview helper renders it with the web's mermaid 11.16.0 and config and the card fits the PNG to its frame, 714 by 191 px against the web's 714 by 195 px (WebKit measures the monospace labels 2 % wider). The pan and zoom buttons and the fullscreen action are missing; Download saves the source. The boot launcher stays mounted across the first project commit (G10 BOOT-REMOUNT, re-landed in G11), and the composer pill names the chat's agent: the c-reply step checks "Chat Scenario Agent" inside the pill. Before G11 LABEL a boot reopen adopting the host's agent took the reuse key from the agent the new chat ran on, and the pill read "Agent" in 2 of 5 GPUIX runs; with the fix 6 of 6 GPUIX and 6 of 6 web runs pass. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.model-selector` Model and mode selector in a running chat | chat | partial | ported | 4/4 | 4/4 | 15.7% / 1.85% |  | The running chat shows the agent chip and composer like the web. The bash code card's body is 81 px between its borders in both, and the card 139 px tall in both (N4: the web's `.chat-streamdown pre` keeps a 0.55em bottom margin inside the body; it was 73 px). The task list lands on the web's columns (bullet 527, checkbox 547, text 565 px in both). The transcript sits 3 px higher than the web's, from the last reply down: its copy and retry icons end 2 px further above the Changed files bar (545 against 548 px, the bar at 602 against 603 px). It predates N4: the user bubble ends at 387 against 390 px on the exp/gpuix-client head too. Links paint in medium primary with their underline, inline code sits in the smaller chip with its padding, and italics are real (N1 and N2 native patches). Task-list items draw Chromium's disabled checkbox at the web's place (G7). The paragraph holding inline code breaks at the same words as the web (G8), and its lines end at 1210, 1190 and 743 px against the web's 1210, 1189 and 746 px (N3: the web reference lays text out with slight hinting, as desktop Chrome does; headless Chromium's default full hinting ended them at 1198, 1175 and 739 px, which G8 read as GPUIX runs 1 % wider). `text-wrap: pretty` is not a cause: `tools/chat/wrap-probe.ts` lays every transcript paragraph out both ways and none breaks differently. Inline-code washes start where the web's chips do (N4: native patch zed/0006 measures a line that opens with a padded chip from the line's origin; GPUI had measured it from the first glyph, so every wash on such a line sat its padding left of the glyphs). On the transcript table the chips' washes start at 516 and 736 px against the web's 516 and 737 px (512 and 734 before N4). |
| `chat.plan` Plan panel from a plan update | chat | partial | ported | 10/10 | 10/10 | 26.5% / 1.88% |  | The pinned Plan panel and the inline plan card show the same three entries, Medium chips, the struck-through finished entry and the 1/3 count, and the short transcript starts at the top in both. The card frames differ. The web card is `bg-card/30` with a `ring-1 ring-border/50` hairline and a divider under its header; GPUIX fills it lighter, with no ring and no divider. The collapse chevron points up in both (G9: compat lifts `rotate-180` and the icon bakes the turn into its SVG). The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.permission` Permission prompt: allow a tool call | chat | ported | ported | 12/12 | 12/12 | 9.4% / 0.97% |  | The Approval needed card, its Allow and Reject buttons, the Needs you badge and the status-bar pill match; clicking Allow answers allow-once in both. The short transcript starts at the top in both. The tab title reads in full at the web width (C15 fixed in G5). The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `chat.queue` Prompt queue while a turn runs | chat | ported | ported | 12/12 | 12/12 | 17.3% / 1.46% |  | The matrix hold bubble, the Working row with "Holding this turn open for the queue." and its block caret, the 1 Queued panel with queued follow-up, and the stop button match. G7 traced the empty transcript of 3 of 3 earlier runs: virtual-list rows were laid out at their fit width, and a row whose only text is a <markdown> (the live narration under Working…) took the markdown's 0 max-content width, wrapped each character onto its own line (a 76 by 809 px row) and pushed the other rows out of view. Rows now span the list. The Working chevron turns down for the open group in both (G9: the motion shim passes `animate.rotate` to the icons below, which bake the turn into their SVG about its centre). The narration check fails only because natively painted markdown text is not in the automation tree. The GPUIX Chats list holds more cards because its pass runs after the web pass on the same server. |
| `composer.mention` Mention menu (@) | composer | ported | ported | 4/4 | 4/4 | 6.6% / 1.27% |  | Both show "No files or folders match" for a bare @ on this server, so the file list itself is not compared here (tools/composer/e2e.ts covers it). The composer shows its focus border and inset ring while it holds the caret, as on the web (I4: its native textarea and key-capture div listen for focus, so the wrapper's `focus-within:` sees it; top edge 35 and 57 against the web's 36 and 58). At rest on the dashboard both clients now show it focused: M3's full run shows the focus border on 88 of 88 web and 81 of 88 GPUIX dashboard frames, and the other 7 GPUIX frames show the resting border. The composer card paints over the top of the workspace strip that follows it, as on the web (G9: the card's `relative z-10` paints in GPUI's deferred pass at priority 10 through native patch gpuix/0011, laid out in place; the card's bottom border is 28 in both, and the send button is undimmed, 30 against the web's 30, 22 before). |
| `composer.slash` Slash command menu (/) | composer | ported | ported | 4/4 | 4/4 | 10.8% / 1.76% |  | The Skills menu matches row for row. The composer shows its focus border and inset ring while it holds the caret, as on the web (I4: its native textarea and key-capture div listen for focus, so the wrapper's `focus-within:` sees it; top edge 35 and 57 against the web's 36 and 58). At rest on the dashboard both clients now show it focused: M3's full run shows the focus border on 88 of 88 web and 81 of 88 GPUIX dashboard frames, and the other 7 GPUIX frames show the resting border. The composer card paints over the top of the workspace strip that follows it, as on the web (G9: the card's `relative z-10` paints in GPUI's deferred pass at priority 10 through native patch gpuix/0011, laid out in place; the card's bottom border is 28 in both, and the send button is undimmed, 30 against the web's 30, 22 before). |
| `composer.attach` Attach a file from the OS file chooser | composer | ported | ported | 5/5 | 5/5 | 8.3% / 1.72% |  | Attach files opens the OS file chooser in both, and the picked matrix-attach.md shows as the same file chip above the prompt (G7: the GPUIX desktop host answers `dialogApi` and the composer picker with GPUI's portal dialog; the matrix drives the real GTK chooser with X key events, and the web answers Playwright's file chooser). The "Failed to open file picker" toast is gone. After the pick both composers show the focus border (top edge 37 and 59 against the web's 37 and 58). G9 traced the resting border of earlier runs to the harness: GPUIX restores focus when its window gets the X input focus back (native patch gpuix/0006), which a window manager does when a dialog closes and Xvfb, which runs none, never did; the matrix now hands the focus back after answering the chooser. A title tooltip paints at once under the pointer after a click, anchored over the element, where the web shows none in the frame. The composer card paints over the top of the workspace strip that follows it, as on the web (G9: the card's `relative z-10` paints in GPUI's deferred pass at priority 10 through native patch gpuix/0011, laid out in place; the card's bottom border is 28 in both, and the send button is undimmed, 30 against the web's 30, 22 before). |
| `terminal.open` Open a terminal from the status bar | terminal | ported | ported | 4/4 | 4/4 | 3.8% / 1.04% |  | Terminal tab, its full "Terminal 1" title at the web width, and the prompt match (C15 fixed in G5). The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. A focused terminal blinks its cursor in both, so a frame shows the block or not by timing. |
| `terminal.type` Type a command and see its output | terminal | ported | ported | 5/5 | 5/5 | 4.2% / 1.21% |  | echo output matches cell for cell. |
| `terminal.vim-replies` Terminal query replies after vim (T1 fixture shape) | terminal | ported | ported | 8/8 | 8/8 | 4.2% / 1.19% |  | With the O1 fixture's command (vim -u NONE -N notes.txt, then :q!) typed into the full app, both clients return to a clean prompt; neither echoes ^[[>0;276;0c or rgb: replies. So the echo in O1's GPUIX shot does not reproduce in the full app with typed input: it belongs to the fixture, which writes its inputs to the PTY back to back, not to GPUIX (inferred; the fixture itself was not rerun here). |
| `terminal.file-link` Ctrl+click a file path in terminal output opens it in the editor | terminal | ported | broken | 8/8 | 7/8 | 5.2% / 1.16% |  | Ctrl+click on src/app.ts in terminal output opens app.ts in a new tab in both. The text check fails only because natively painted text is not in the automation tree. |
| `terminal.new-tab-menu` New tab menu (terminal, browser, ...) | terminal | ported | ported | 3/3 | 3/3 | 8.9% / 1.57% |  | The new tab menu matches. GPUIX adds New browser tab, since only the GPUIX client has browser panes. |
| `terminal.tab-reorder` Reorder terminal tabs by dragging | terminal | ported | ported | 10/10 | 10/10 | 4.0% / 1.05% |  | Dropping Terminal 2 on the left edge of Terminal 1 moves it first in both, and both clients read Terminal 2, Terminal 1 with full titles at the web widths (C15 fixed in G5). In the full M3 run, and in 1 of 5 runs of terminal.split, GPUIX opened the New tab menu but only Terminal 1: the Bash click replayed the web point before GPUIX had painted the menu. The surfaces now click Bash by its text, which waits for the item (M3 harness fix); 4 of 4 runs then passed, and the row is from one of them. |
| `terminal.split` Split panes: drag a second terminal tab to the pane edge | terminal | ported | ported | 12/12 | 12/12 | 4.2% / 1.34% |  | Dragging the Terminal 2 tab to the pane's right edge splits the pane in both (D1), and each pane's tab shows its full title with its close button (C15 fixed in G5). Both focus the moved Terminal 2: its block cursor is the focused one in both (M3 runs after the Bash fix; see terminal.tab-reorder for the lost click). |
| `statusbar.items` Status bar items | statusbar | ported | partial | 2/2 | 2/2 | 7.6% / 1.63% | 12.1% / 4.63% | Branch, path, Terminal and settings items line up. The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. The rest of the region diff is glyph antialiasing: Chromium draws the status bar text with subpixel (LCD) colour fringes, and GPUIX draws it in grayscale (C8). |
| `statusbar.context-bar` Context bar settings popover | statusbar | ported | ported | 3/3 | 3/3 | 8.4% / 1.60% |  | The Show in Context Bar popover opens with the same five toggles and states. |
| `statusbar.connection` Connection indicator hover | statusbar | ported | ported | 3/3 | 3/3 | 8.2% / 1.69% |  | Hovering the connection lamp shows the Connected tooltip in both. The status-bar connection lamp is a filled dot as on the web (C7 fixed in G3: fill-current fills the icon), 1 px higher. |
| `remote.access-popover` Remote access popover (desktop shared-live host) | remote | pending-unit | pending-unit | n/a | n/a |  |  | GPUIX has no remote access popover yet; StatusBar renders it only under isTauriContext(). The reference is the desktop app (`tools/reference/tauri.ts`), whose status bar has the button. |
| `settings.interface` Settings: Interface | settings | ported | ported | 5/5 | 5/5 | 31.4% / 0.36% | 3.1% / 0.53% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.notifications` Settings: Notifications | settings | ported | ported | 5/5 | 5/5 | 31.8% / 0.55% | 3.7% / 0.81% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). A row's label sits on the web's 24 px line (G12: the inline `<label>` alone on a line of its block parent gets the parent's strut, so the text column is 45 px against the web's 45.5 and the row 69 against 70; it was 41 and 65, with the label 3 px high). |
| `settings.editor` Settings: Editor | settings | ported | ported | 5/5 | 5/5 | 31.1% / 0.20% | 2.6% / 0.29% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). A row's label sits on the web's 24 px line (G12: the inline `<label>` alone on a line of its block parent gets the parent's strut, so the text column is 45 px against the web's 45.5 and the row 69 against 70; it was 41 and 65, with the label 3 px high). |
| `settings.appearance` Settings: Appearance | settings | ported | ported | 5/5 | 5/5 | 33.0% / 0.82% | 5.5% / 1.21% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). A row's label sits on the web's 24 px line (G12: the inline `<label>` alone on a line of its block parent gets the parent's strut, so the text column is 45 px against the web's 45.5 and the row 69 against 70; it was 41 and 65, with the label 3 px high). |
| `settings.shell` Settings: Shell | settings | ported | ported | 5/5 | 5/5 | 30.7% / 0.20% | 2.0% / 0.30% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.terminal-profiles` Settings: Profiles | settings | ported | ported | 5/5 | 5/5 | 31.2% / 0.29% | 2.8% / 0.43% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.ai-agents` Settings: Agent chats | settings | partial | ported | 5/5 | 5/5 | 32.8% / 0.69% | 5.1% / 1.01% | Each select is one closed dropdown like the web (G2), and its trigger is 240px wide beside the label as on the web (G5: the GPUIX ui primitives resolve `@[35rem]:w-60` against the settings card container). The web truncates a long value (`[&>span]:line-clamp-1`); GPUIX shows it in full inside the 240px. The agents list shows No agents match "" while the web lists the registry (Agoragentic first). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). A row's label sits on the web's 24 px line (G12: the inline `<label>` alone on a line of its block parent gets the parent's strut, so the text column is 45 px against the web's 45.5 and the row 69 against 70; it was 41 and 65, with the label 3 px high). The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.skills` Settings: Skills | settings | ported | ported | 5/5 | 5/5 | 33.1% / 0.65% | 5.5% / 0.96% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each `text-xs leading-relaxed` line sits 19.5 px below the last, as on the web, so later rows no longer drift (N3: native patch zed/0005 keeps the line height fractional; on settings.skills the lines start at 254, 274, 293, 313 and 333 against the web's 254, 274, 293, 313 and 332, and the last row at 658 against 659, where G12 measured 19 px steps and a 5 px drift). |
| `settings.provider` Settings: Accounts | settings | partial | ported | 5/5 | 5/5 | 32.5% / 0.51% | 4.6% / 0.75% | Accounts lists the Default account, Signed in, with "Usage is not available right now", Try again and the `termul-server claude account` hint in both. The skeleton M2 saw was the frame grab racing the list: the step checked for the nav label it had just clicked. It now waits for "1 account", which GPUIX painted 1871 ms after the click and the web 158 ms after (G6 run). GPUIX puts the usage note under the account name, where the web sets it beside the name in the wide layout. The scrim dims and blurs the page behind it as on the web (N2). |
| `settings.mcp-servers` Settings: MCP servers | settings | partial | ported | 5/5 | 5/5 | 35.3% / 1.09% | 8.8% / 1.60% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). The inline code in the footnote breaks onto its own line. |
| `settings.shortcuts` Settings: Keyboard shortcuts | settings | ported | ported | 5/5 | 5/5 | 32.8% / 0.42% | 5.1% / 0.62% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each `text-xs leading-relaxed` line sits 19.5 px below the last, as on the web, so later rows no longer drift (N3: native patch zed/0005 keeps the line height fractional; on settings.skills the lines start at 254, 274, 293, 313 and 333 against the web's 254, 274, 293, 313 and 332, and the last row at 658 against 659, where G12 measured 19 px steps and a 5 px drift). GPUIX lists the desktop keymap (Ctrl+R, Ctrl+T, Ctrl+,) where the web lists its defaults (Press keys…, Alt+T, Alt+,), by design since G4. |
| `settings.diagnostics` Settings: Logs | settings | ported | ported | 5/5 | 5/5 | 34.5% / 0.51% | 7.6% / 0.74% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). Rows inside a settings group are separated by the divider line as on the web (G6: `divide-y divide-border` in the style layer). Each `text-xs leading-relaxed` line sits 19.5 px below the last, as on the web, so later rows no longer drift (N3: native patch zed/0005 keeps the line height fractional; on settings.skills the lines start at 254, 274, 293, 313 and 333 against the web's 254, 274, 293, 313 and 332, and the last row at 658 against 659, where G12 measured 19 px steps and a 5 px drift). Server version reads termul-server v0.4.52 in both: GPUIX asks the server (G4). |
| `settings.reset` Settings: Reset | settings | ported | ported | 5/5 | 5/5 | 31.2% / 0.40% | 2.8% / 0.59% | The section content and navigation match. The scrim dims and blurs the page behind it as on the web (N2). |
| `palette.open` Command palette (Ctrl+K) and filtering | palette | ported | ported | 9/9 | 9/9 | 7.5% / 1.51% |  | Ctrl+K opens the palette, typing "theme" filters it to the same groups and rows in both, and Escape closes it. The Agent Launcher row's chip reads ctrl+t in GPUIX and alt+t on the web (the G4 desktop keymap). The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.type-ahead` Typing straight after Ctrl+K reaches the palette filter | palette | ported | ported | 5/5 | 5/5 | 73.8% / 0.15% |  | Typing "theme" straight after Ctrl+K filters the palette in both, and the rows rank the same (C16 fixed in G3: the cmdk shim scores with cmdk's command-score and sorts as cmdk does), Open Canvas first under Workspace. GPUIX is deterministic (G5): keys typed after the palette input took focus but before it first painted focused, which GPUI drops for want of a text input handler, are held and given to the field on its focus event. It passed 7 of 7 G5 runs, where it had failed 3 of 5 with the window active (an empty filter). The web still races: CommandPalette blurs the active element and focuses its input in a setTimeout(0), so keys that beat that timeout are dropped ("eme" in 2 of 12 G5 runs). That is a real web bug a fast typist can hit, not a harness artifact. The search field shows its focus underline as on the web (G5: the matrix makes the GPUIX window the active X window, as the Playwright page is focused; an inactive GPUI window gets no focus events). |
| `palette.new-terminal` Palette command: New Terminal | palette | ported | ported | 8/8 | 8/8 | 3.7% / 1.06% |  | New Terminal opens Terminal 1 in both. A focused terminal blinks its cursor in both, so a frame shows the block or not by timing. M2's terminal-limit frame showed the GPUIX error toast too narrow for its message: the text runs past the window edge, where the web toast wraps to two lines. M3 hit no limit, so that toast was not seen again. |
| `palette.agent-launcher` Palette command: Agent Launcher | palette | ported | ported | 9/9 | 9/9 | 48.5% / 1.40% |  | Agent Launcher shows the launcher with its close button in both. |
| `palette.save-snapshot` Palette command: Save Workspace Snapshot | snapshots | ported | ported | 9/9 | 9/9 | 82.7% / 0.06% |  | The Create Snapshot modal matches. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.open-canvas` Palette command: Open Canvas | palette | ported | ported | 10/10 | 10/10 | 3.9% / 1.00% |  | Open Canvas opens design.figcraft in both, and the FigCraft editor reaches Ready in GPUIX through the browser-pane webview (V1) with the pinned bundle (run with `tools/canvas/server-with-bundle.ts`). The editor is dark in both, page colour 1E1E1E (G6: the webview helper starts on the dark GTK theme while Termul is dark, so WebKitGTK reports prefers-color-scheme dark before host.theme arrives). |
| `palette.project-settings` Palette command: Project Settings | palette | ported | ported | 9/9 | 9/9 | 30.8% / 0.14% |  | Project settings opens on General with the same fields. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.app-preferences` Palette command: App Preferences | palette | ported | ported | 9/9 | 9/9 | 31.4% / 0.36% |  | Preferences opens on Interface in both, laid out wide. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). M3 matched in its full run. M2 saw two flakes here: the automation bounds-query timeout (C13) and a frame grabbed at the container-query first layout, before the card measured itself. |
| `palette.switch-project` Palette command: beta | rail | ported | ported | 12/12 | 12/12 | 5.6% / 0.85% |  | Typing beta filters to the beta row and Enter switches to beta in both. After the switch the beta composer shows Chat Scenario Agent in both. GPUIX gets there later: the agent chip appeared 967 ms (rail) and 586 ms (palette) after the switch in GPUIX and within 82 ms on the web (G6 run; the step now waits for it, so the frames match). |
| `palette.command-history` Palette command: Command History | palette | ported | ported | 9/9 | 9/9 | 80.2% / 0.11% |  | The Command History modal, its scope picker and empty state match, and the search field shows its focus border in both. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.color-theme` Palette command: Change Color Theme | palette | ported | ported | 9/9 | 9/9 | 20.2% / 0.92% |  | Change Color Theme opens the Color Themes popover in both. The focused field shows its focus border as on the web (G6: native patch gpuix/0009 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). |
| `palette.shortcut-menu` Palette command: Open Shortcut Menu | palette | ported | ported | 9/9 | 9/9 | 77.4% / 0.13% |  | Opens the Shortcut Menu in both; GPUIX shows the desktop keymap chips (see shortcuts.menu). The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `palette.report-bug` Palette command: Report a Bug | palette | ported | ported | 9/9 | 9/9 | 59.1% / 0.19% |  | Opens the Report a bug dialog, laid out as in dialogs.bug-report. The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). The focused field shows its focus border as on the web (G6: native patch gpuix/0009 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). |
| `shortcuts.menu` Keyboard shortcuts popover | shortcuts | ported | ported | 3/3 | 3/3 | 75.6% / 0.13% |  | Shortcut Menu rows, descriptions and key chips line up. GPUIX shows the desktop keymap chips (Ctrl+R, Ctrl+,, Ctrl+=) where the web shows its Alt defaults and a blank Command History chip (G4, by design). The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `shortcuts.settings-shortcut` Settings shortcut (web Alt+,, desktop Ctrl+,); Escape closes the dialog | shortcuts | ported | ported | 6/6 | 6/6 | 7.5% / 1.51% |  | Each client presses its own key (G3): Alt+, on the web and the desktop Ctrl+, in GPUIX (G4 keymap) open Preferences, and Escape closes it in both. |
| `shortcuts.toggle-projects` Default shortcut ctrl-shift-b: collapse the project rail | shortcuts | ported | ported | 5/5 | 5/5 | 7.8% / 1.38% |  | Ctrl+Shift+B collapses the rail in both, with the Open canvas pencil under Search (see rail.collapse). After the shortcut both composers rest unfocused (G12). The step first clicks the rail's Projects label, and the web blurs the composer there: Chromium's default action for a press no listener prevented moves focus to body when the pressed content takes none. GPUIX now does the same (`compat/window-press.ts`), where GPUI had kept the composer focused. |
| `shortcuts.toggle-side-panel` Default shortcut ctrl-b: hide the side panel | shortcuts | ported | ported | 5/5 | 5/5 | 5.7% / 0.80% |  | Ctrl+B hides the side panel in both. After the shortcut both composers rest unfocused (G12). The step first clicks the rail's Projects label, and the web blurs the composer there: Chromium's default action for a press no listener prevented moves focus to body when the pressed content takes none. GPUIX now does the same (`compat/window-press.ts`), where GPUI had kept the composer focused. |
| `shortcuts.theme-picker` Default shortcut ctrl-alt-t: theme picker | shortcuts | ported | ported | 5/5 | 5/5 | 20.2% / 0.92% |  | Ctrl+Alt+T opens the Color Themes popover in both. The focused field shows its focus border as on the web (G6: native patch gpuix/0009 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). |
| `shortcuts.zoom-in` Default shortcut alt-=: zoom in | shortcuts | partial | partial | 5/5 | 5/5 | 17.4% / 3.59% |  | Each client presses its own key (G3: the web Alt+=, GPUIX the desktop Ctrl+= from G4's keymap), and both zoom: the rail and sidebar widen alike (G4, shims/window-zoom.ts; tools/parity/zoom-check.ts measures the rail 200 -> 220 px in both). The zoomed web page runs past the window bottom, so its status bar is cut off and the dashboard heading sits 25 px lower; GPUIX keeps the status bar in the window. After the shortcut both composers rest unfocused (G12). The step first clicks the rail's Projects label, and the web blurs the composer there: Chromium's default action for a press no listener prevented moves focus to body when the pressed content takes none. GPUIX now does the same (`compat/window-press.ts`), where GPUI had kept the composer focused. |
| `shortcuts.desktop-keymap` Desktop key bindings (Ctrl+T, Ctrl+W, Ctrl+R, Ctrl+, and Ctrl+=) | shortcuts | partial | partial | 33/33 | 33/33 | 14.9% / 2.32% |  | Reference (R5): the web client with the desktop table bound as custom keys, as a web user can set them in Keyboard shortcuts; GPUIX presses the same keys with its default (desktop) keymap. Headless Chromium hands Ctrl+T, Ctrl+W and Ctrl+R to the page. Every key does the same in both: Ctrl+T shows the agent launcher over Terminal 1 and a second Ctrl+T hides it, Ctrl+W asks to close Terminal 1 and Close removes it, Ctrl+R opens Command History, Ctrl+, opens Preferences and Ctrl+= zooms in. The last frame differs as in shortcuts.zoom-in: the zoomed web page runs past the window bottom, and GPUIX keeps the status bar in the window. |
| `theme.picker` Theme picker | theme | ported | ported | 4/4 | 4/4 | 20.2% / 0.92% |  | The Color Themes popover, groups, swatches and the current-theme check match, and labels antialias in grayscale as on the web (C8 fixed in G3). The focused field shows its focus border as on the web (G6: native patch gpuix/0009 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). |
| `dialogs.bug-report` Report a bug dialog | dialogs | ported | ported | 3/3 | 3/3 | 59.1% / 0.19% |  | The Report a bug dialog paints its Title, What happened, Screenshots and Preview sections at the web width and wraps the same lines. The web draws a resize grip in the What happened corner; GPUIX has none. The focused field shows its focus border as on the web (G6: native patch gpuix/0009 applies a text field's `focus-visible:` style on any focus, in the frame focus moves). The scrim dims and blurs the page behind it as on the web (N2 backdrop blur, native patches zed/0003 and gpuix/0005). |
| `canvas.open` Canvas | canvas | ported | ported | 4/4 | 4/4 | 4.5% / 1.00% |  | Clicking Canvas opens design.figcraft and the FigCraft editor reaches Ready in both: pages, layers, design panel, toolbar and Save (V1: the editor runs in a `termul-webview-host` webview placed over the pane; this run used the pinned bundle, sha256 verified against canvas/figcraft.pin). Panels and page are dark in both, page colour 1E1E1E (G6, see palette.open-canvas). |
| `browser.pane` Browser pane | browser | partial | ported | tauri 9/9 | 11/11 | 2.8% / 1.10% | 1.8% / 0.95% | Reference (R5): the desktop app (Tauri on WebKitGTK) built from the same checkout, driven with X input at the same 1280x800 (`tools/reference/tauri.ts`). Ctrl+Shift+N opens a browser tab in both and the typed URL loads the local reference page. Both panes are WebKitGTK webviews, and the page lands on the same pixels; the pane region reads 0.94 % perceptual. GPUIX shows the Debug Console button beside the URL field. BrowserControls shows it only when `import.meta.env.PROD` is false, and the GPUIX bundle does not define it; the desktop app's and the web's production builds hide it. The desktop app injects its agentation toolbar into every page it loads (browser_tab_manager.rs, enabled by default), a round button at the page's bottom right; the GPUIX helper injects it only on a click. The desktop tab still reads 127.0.0.1:8289 after the page loaded; GPUIX names the tab after the page title. The desktop app draws its own window buttons at the right of the tab bar; GPUIX leaves them to the window manager. The rail differs outside the pane: the desktop app is host-local (an SSH section) and has no seeded chat. |
| `notifications.toast` Toast after creating a branch | notifications | ported | ported | 7/7 | 7/7 | 8.4% / 1.68% |  | Typing the branch name and pressing Enter creates toast-branch and shows the success toast in both. The toast matches the web card (G4 native toaster): check icon, close button over the top-left corner, Arial text (sonner sets its own font stack); the toast crop differs 0.85 % perceptual. After Enter the status-bar branch button holds focus and both draw a 1 px ring around "toast-branch" (G6: an outer ring paints as an outline; GPUI had painted the spread shadow under the whole transparent button, a light wash over the label). |
| `ssh.workspace` SSH profiles and sessions | ssh | partial | ported | web host-local 8/8 | 8/8 | 62.0% / 1.47% |  | Reference (R5): the web client with the host-local credential added to its handshake, and GPUIX attached with the same credential, as the launched app is. Both list the two seeded hosts in the sidebar SSH section, with the build-box favourite first. The Hosts tab matches: the search field, Import and New host, and the Favorites and Servers groups with the same rows. The New host dialog differs. The web sets Address and Port on one row (`grid-cols-[1fr_6rem]`); GPUIX stacks Port under Address, so the Organize section is scrolled out of the dialog. |
| `settings.accounts-claude` Claude account sign-in | settings | partial | ported | web host-local 10/10 | 10/10 | 71.1% / 0.19% | 79.5% / 0.27% | Reference (R5): the web client with the host-local credential, and GPUIX attached with the same credential. Both show Add account, the Keep work and personal apart card, and the Add a Claude account dialog with the name typed. The run stops before Continue, which would start a real claude.ai sign-in on the host. The Accounts section has the gap settings.provider has: GPUIX puts the usage note under the account name, and the row menu on a line of its own, where the web sets them beside the name. |
| `update.toast` Update available toast and what's new modal | notifications | pending-unit | pending-unit | n/a | n/a |  |  | GPUIX has neither the update toast nor the what's new modal; App.tsx renders both only under isTauriContext(). The reference is the desktop app (`tools/reference/tauri.ts`): the toast against a release feed, the modal after a version change. The packaged GPUIX app has a command-line check, `termul-gpuix --check-update`. |
| `snapshots.page` Snapshots page (#/snapshots) | snapshots | partial | ported | 5/5 | 5/5 | 81.2% / 0.40% |  | Reference (R5): both clients start on #/snapshots, the web by URL and GPUIX through GPUIX_START_HASH; no desktop shell links to the route (only the mobile drawer). The header, Create New Snapshot and the Create Snapshot dialog match. GPUIX paints nothing under the header where the web shows the empty state: the camera, No snapshots yet and Create First Snapshot. The text is in the automation tree, so the check passes; the block is not painted. |
| `theme.termul-dark` Theme termul (dark) | theme | ported | ported | 2/2 | 2/2 | 7.7% / 1.68% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.termul-light` Theme termul (light) | theme | ported | ported | 2/2 | 2/2 | 5.5% / 1.77% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.cursor-dark` Theme cursor (dark) | theme | ported | ported | 2/2 | 2/2 | 5.0% / 1.52% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.cursor-light` Theme cursor (light) | theme | ported | ported | 2/2 | 2/2 | 5.6% / 1.72% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.catppuccin-dark` Theme catppuccin (dark) | theme | ported | ported | 2/2 | 2/2 | 7.6% / 1.49% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.catppuccin-light` Theme catppuccin (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.49% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.dracula-dark` Theme dracula (dark) | theme | ported | ported | 2/2 | 2/2 | 5.4% / 1.55% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.dracula-light` Theme dracula (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.64% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.nord-dark` Theme nord (dark) | theme | ported | ported | 2/2 | 2/2 | 5.5% / 1.54% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.nord-light` Theme nord (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.57% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.gruvbox-dark` Theme gruvbox (dark) | theme | ported | ported | 2/2 | 2/2 | 7.7% / 1.48% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.gruvbox-light` Theme gruvbox (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.55% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.tokyonight-dark` Theme tokyonight (dark) | theme | ported | ported | 2/2 | 2/2 | 7.6% / 1.48% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.tokyonight-light` Theme tokyonight (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.53% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.ayu-dark` Theme ayu (dark) | theme | ported | ported | 2/2 | 2/2 | 5.5% / 1.49% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.ayu-light` Theme ayu (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.58% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.one-dark-dark` Theme one-dark (dark) | theme | ported | ported | 2/2 | 2/2 | 7.7% / 1.23% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.one-dark-light` Theme one-dark (light) | theme | ported | ported | 2/2 | 2/2 | 6.0% / 1.63% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.github-dark` Theme github (dark) | theme | ported | ported | 2/2 | 2/2 | 7.3% / 1.50% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |
| `theme.github-light` Theme github (light) | theme | ported | ported | 2/2 | 2/2 | 5.6% / 1.68% |  | Background, panel, card, border, text and accent colours match the web dashboard. The differences left are not the theme. |

### Driven interactions and literal results

- `rail.project-list` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-project-list/`):
  - `a-dashboard`: present "alpha": web pass, gpuix pass; present "beta": web pass, gpuix pass; present "gamma": web pass, gpuix pass; present "delta": web pass, gpuix pass; present "What should we do in alpha?": web pass, gpuix pass
  - `b-switch-beta`: click #project-item-m1-beta (web ok; gpuix ok via testid); present "What should we do in beta?": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass; gone "Loading model…": web pass, gpuix pass; gone "Composer unavailable": web pass, gpuix pass
- `rail.project-menu` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-project-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: right-click #project-item-m1-beta (web ok; gpuix ok via testid); present "Rename": web pass, gpuix pass
- `rail.project-rename` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-project-rename/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-rename`: right-click #project-item-m1-gamma (web ok; gpuix ok via testid); click "Rename" (web ok; gpuix ok via text); click [data-testid="shell-rail"] input (web ok; gpuix ok via web-point); press ctrl-a (web ok; gpuix ok via key); type "gamma-renamed" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); present "gamma-renamed": web pass, gpuix pass
- `rail.project-remove` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-project-remove/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-confirm`: right-click #project-item-m1-delta (web ok; gpuix ok via testid); click "Delete" (web ok; gpuix ok via text); present "Delete Project": web pass, gpuix pass
  - `c-removed`: click [Delete] (web ok; gpuix ok via web-point); gone "delta": web pass, gpuix pass
- `rail.project-colour` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-project-colour/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: right-click #project-item-m1-beta (web ok; gpuix ok via testid); click "Change Color" (web ok; gpuix ok via text); present "Select Color": web pass, gpuix pass
- `rail.project-reorder` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-project-reorder/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-dragged`: drag #project-item-m1-gamma -> #project-item-m1-alpha (web ok; gpuix ok via testid); wait 500 ms (web ok; gpuix ok via none); present "alpha < gamma < beta": web pass, gpuix pass
- `rail.add-menu` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-add-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [Add project or folder group] (web ok; gpuix ok via web-point); present "New project": web pass, gpuix pass
  - `c-modal`: click "New project" (web ok; gpuix ok via text); present "Create": web pass, gpuix pass
- `rail.collapse` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-collapse/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-collapsed`: click [Expand or collapse projects] (web ok; gpuix ok via web-point); gone "Projects": web pass, gpuix pass
- `rail.project-settings` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/rail-project-settings/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-beta`: click #project-item-m1-beta (web ok; gpuix ok via testid); present "What should we do in beta?": web pass, gpuix pass
  - `c-settings`: click [Settings for beta] (web ok; gpuix ok via web-point); present "Basic project identification and location.": web pass, gpuix pass
- `side.chats` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/side-chats/`):
  - `a-chats`: present "How does the web client decide which routes rend": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass
- `side.chats-search` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/side-chats-search/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-miss`: click input[placeholder^="Search chats"] (web ok; gpuix ok via web-point); type "zzz-no-match" (web ok; gpuix ok via key); gone "How does the web client decide which routes rend": web pass, gpuix pass
  - `c-hit`: press ctrl-a (web ok; gpuix ok via key); type "routes" (web ok; gpuix ok via key); present "How does the web client decide which routes rend": web pass, gpuix pass
- `side.chat-card-menu` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/side-chat-card-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: right-click "How does the web client decide which routes rend" (web ok; gpuix ok via text); present "Open in split": web pass, gpuix pass; present "Copy Path": web pass, gpuix pass; present "Delete Chat": web pass, gpuix pass
- `side.workspace-switcher` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/side-workspace-switcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Workspace] (web ok; gpuix ok via web-point); present "Current checkout": web pass, gpuix pass
- `side.hide` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/side-hide/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-hidden`: click [Hide side panel] (web ok; gpuix ok via web-point); gone "How does the web client decide which routes rend": web pass, gpuix pass
- `explorer.tree` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/explorer-tree/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "src": web pass, gpuix pass; present "docs": web pass, gpuix pass; present "README.md": web pass, gpuix pass; present "notes.txt": web pass, gpuix pass
- `explorer.expand` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/explorer-expand/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "src": web pass, gpuix pass
  - `c-expanded`: click "src" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass; present "utils.ts": web pass, gpuix pass
- `explorer.context-menu` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/explorer-context-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-menu`: right-click "README.md" (web ok; gpuix ok via text); present "Rename": web pass, gpuix pass; present "Delete": web pass, gpuix pass
- `explorer.drag` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/explorer-drag/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); present "notes.txt": web pass, gpuix pass; present "docs": web pass, gpuix pass
  - `c-dropped`: drag "notes.txt" -> [data-pane-content] (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "untracked notes": web pass, gpuix FAIL
- `editor.code` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/editor-code/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-open`: click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
- `editor.code-edit` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/editor-code-edit/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "Explorer" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
  - `c-typed`: click "VERSION" (web ok; gpuix ok via web-point); press end (web ok; gpuix ok via key); type " // edited" (web ok; gpuix ok via key); present "// edited": web pass, gpuix FAIL
- `editor.markdown` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/editor-markdown/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-tree`: click "Explorer" (web ok; gpuix ok via text); click "docs" (web ok; gpuix ok via text); present "guide.md": web pass, gpuix pass
  - `c-open`: click "guide.md" (web ok; gpuix ok via text); present "Alpha guide": web pass, gpuix pass; present "Setup": web pass, gpuix pass
- `editor.tabs` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/editor-tabs/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click "Explorer" (web ok; gpuix ok via text); click "README.md" (web ok; gpuix ok via text); click "src" (web ok; gpuix ok via text); click "app.ts" (web ok; gpuix ok via text); present "export function greet": web pass, gpuix FAIL
  - `c-back`: click [role="tab"]:has-text("README.md") (web ok; gpuix ok via web-point); present "The matrix project.": web pass, gpuix FAIL
- `git.changes` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-changes/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass; present "README.md": web pass, gpuix pass; present "notes.txt": web pass, gpuix pass
- `git.amend` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-amend/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "Amend last commit": web pass, gpuix pass
  - `c-label`: click "Amend last commit" (web ok; gpuix ok via text); wait 400 ms (web ok; gpuix ok via none); present "Amend commit": web pass, gpuix pass
  - `d-box`: click input[type="checkbox"] (web ok; gpuix ok via web-point); wait 400 ms (web ok; gpuix ok via none); gone "Amend commit": web pass, gpuix pass
- `git.diff` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-diff/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-diff`: click "README.md" (web ok; gpuix ok via text); present "An unstaged line.": web pass, gpuix pass
- `git.stage` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-stage/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-staged`: click [Stage changes] (web ok; gpuix ok via web-point); present "README.md": web pass, gpuix pass
- `git.unstage` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-unstage/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-unstaged`: click [Unstage changes] (web ok; gpuix ok via web-point); present "app.ts": web pass, gpuix pass
- `git.discard` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-discard/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "README.md": web pass, gpuix pass
  - `c-confirm`: click [Discard changes] (web ok; gpuix ok via web-point); present "Discard": web pass, gpuix pass
- `git.commit` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-commit/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-changes`: click "Changes" (web ok; gpuix ok via text); present "app.ts": web pass, gpuix pass
  - `c-message`: click input[placeholder="Summary (required)"] (web ok; gpuix ok via web-point); type "bump version" (web ok; gpuix ok via key)
  - `d-committed`: click [Commit to main] (web ok; gpuix ok via web-point); gone "app.ts": web pass, gpuix pass
- `git.branch-picker` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-branch-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: click [Switch git branch] (web ok; gpuix ok via web-point); present "feature/login": web pass, gpuix pass
- `git.worktree-create` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/git-worktree-create/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-switcher`: click [Workspace] (web ok; gpuix ok via web-point); present "main": web pass, gpuix pass
  - `c-typed`: type "feat-matrix" (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none)
- `chat.transcript` (frames `/tmp/gpuix-n4/m-after/chat-transcript/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "One more place parses it": web pass, gpuix pass; present "Changed files": web pass, gpuix pass
- `chat.scroll-top` (frames `/tmp/gpuix-n4/m-after/chat-scroll-top/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "One more place parses it": web pass, gpuix pass
  - `c-top`: wheel -20000 over "One more place parses it" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Three call sites depend on it": web pass, gpuix pass
- `chat.table-fullscreen` (frames `/tmp/gpuix-n4/m-after/chat-table-fullscreen/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none)
  - `c-top`: wheel -20000 over "One more place parses it" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none)
  - `d-fullscreen`: click [View fullscreen] (web ok; gpuix ok via web-point); wait 800 ms (web ok; gpuix ok via none); present "WorkspaceSnapshots": web pass, gpuix pass
- `chat.new-chat` (frames `/tmp/gpuix-n4/m-after/chat-new-chat/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-new`: click [New chat] (web ok; gpuix ok via web-point); present "Chat Scenario Agent": web pass, gpuix pass
- `chat.agent-launcher` (frames `/tmp/gpuix-n4/m-after/chat-agent-launcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click button[aria-label^="Agent and model"] (web ok; gpuix ok via web-point); present "This agent gives no model": web pass, gpuix pass
- `chat.send` (frames `/tmp/gpuix-n4/m-after/chat-send/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-typed`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "Explain the router" (web ok; gpuix ok via key); present "Explain the router": web pass, gpuix pass
  - `c-reply`: press enter (web ok; gpuix ok via key); wait 4000 ms (web ok; gpuix ok via none); present "The router docs cover the hash variant in more depth": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass
- `chat.model-selector` (frames `/tmp/gpuix-n4/m-after/chat-model-selector/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click "How does the web client decide which routes rend" (web ok; gpuix ok via text); wait 1000 ms (web ok; gpuix ok via none); present "Chat Scenario Agent": web pass, gpuix pass
- `chat.plan` (frames `/tmp/gpuix-n4/m-after/chat-plan/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-reply`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix plan" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 3000 ms (web ok; gpuix ok via none); present "Here is the plan for the router work.": web pass, gpuix pass
  - `c-panel`: present "Plan": web pass, gpuix pass; present "Read the router module": web pass, gpuix pass; present "Write the hash router tests": web pass, gpuix pass; present "Update the router docs": web pass, gpuix pass
- `chat.permission` (frames `/tmp/gpuix-n4/m-after/chat-permission/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-prompt`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix permission" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 3000 ms (web ok; gpuix ok via none); present "Run the router test suite": web pass, gpuix pass; present "Allow": web pass, gpuix pass; present "Reject": web pass, gpuix pass
  - `c-allowed`: click "Allow" (web ok; gpuix ok via text); wait 1500 ms (web ok; gpuix ok via none); present "Permission answer: allow-once": web pass, gpuix pass; gone "Reject": web pass, gpuix pass
- `chat.queue` (frames `/tmp/gpuix-n4/m-after/chat-queue/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-holding`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "matrix hold" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 2500 ms (web ok; gpuix ok via none); present "Holding this turn open for the queue.": web pass, gpuix pass
  - `c-queued`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "queued follow-up" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 1200 ms (web ok; gpuix ok via none); present "Queued": web pass, gpuix pass; present "queued follow-up": web pass, gpuix pass
- `composer.mention` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/composer-mention/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "@" (web ok; gpuix ok via key); present "No files or folders match": web pass, gpuix pass
- `composer.slash` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/composer-slash/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [contenteditable="true"], textarea (web ok; gpuix ok via web-point); type "/" (web ok; gpuix ok via key); present "Skills": web pass, gpuix pass
- `composer.attach` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/composer-attach/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-attach`: choose attach/matrix-attach.md from [Attach files] (web ok; gpuix ok via web-point); wait 800 ms (web ok; gpuix ok via none); present "matrix-attach.md": web pass, gpuix pass; gone "Failed to open file picker": web pass, gpuix pass
- `terminal.open` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/terminal-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none); present "Terminal": web pass, gpuix pass
- `terminal.type` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/terminal-type/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-echo`: type "echo matrix-$((6*7)) " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
- `terminal.vim-replies` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/terminal-vim-replies/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-vim`: type "vim -u NONE -N notes.txt " (web ok; gpuix ok via key); wait 2500 ms (web ok; gpuix ok via none)
  - `d-quit`: press escape (web ok; gpuix ok via key); type ":q! " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
- `terminal.file-link` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/terminal-file-link/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none)
  - `c-echo`: type "clear && echo src/app.ts " (web ok; gpuix ok via key); wait 1500 ms (web ok; gpuix ok via none)
  - `d-link`: ctrl-click .xterm-screen (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none); present "export function greet": web pass, gpuix FAIL
- `terminal.new-tab-menu` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/terminal-new-tab-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-menu`: click [New tab] (web ok; gpuix ok via web-point); present "Terminal": web pass, gpuix pass
- `terminal.tab-reorder` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/terminal-tab-reorder/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); click [New tab] (web ok; gpuix ok via web-point); click "Bash" (web ok; gpuix ok via text); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
  - `c-reordered`: drag "Terminal 2" -> [role="tab"]:has-text("Terminal 1") (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none)
- `terminal.split` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/terminal-split/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-two`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2000 ms (web ok; gpuix ok via none); click [New tab] (web ok; gpuix ok via web-point); click "Bash" (web ok; gpuix ok via text); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
  - `c-split`: drag "Terminal 2" -> [data-pane-content] (web ok; gpuix ok via text); wait 2000 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; present "Terminal 2": web pass, gpuix pass
- `statusbar.items` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/statusbar-items/`):
  - `a-dashboard`: present "main": web pass, gpuix pass; present "Terminal": web pass, gpuix pass
- `statusbar.context-bar` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/statusbar-context-bar/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-popover`: click [Context bar settings] (web ok; gpuix ok via web-point); present "Branch": web pass, gpuix pass
- `statusbar.connection` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/statusbar-connection/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-hover`: hover [Connected] (web ok; gpuix ok via web-point); wait 1200 ms (web ok; gpuix ok via none)
- `remote.access-popover`: pending R4 desktop host role over the server: GPUIX has no remote access popover yet (StatusBar renders it only under isTauriContext()); the reference is the desktop app's status-bar popover (tools/reference/tauri.ts)
- `settings.interface` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-interface/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Interface" (web ok; gpuix ok via text); present "Interface zoom": web pass, gpuix pass
- `settings.notifications` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-notifications/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Notifications" (web ok; gpuix ok via text); present "Notify when a terminal agent finishes": web pass, gpuix pass
- `settings.editor` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-editor/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Editor" (web ok; gpuix ok via text); present "Auto save delay": web pass, gpuix pass
- `settings.appearance` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-appearance/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Appearance" (web ok; gpuix ok via text); present "Font size": web pass, gpuix pass
- `settings.shell` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-shell/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Shell" (web ok; gpuix ok via text); present "Default shell": web pass, gpuix pass
- `settings.terminal-profiles` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-terminal-profiles/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Profiles" (web ok; gpuix ok via text); present "No terminal profiles": web pass, gpuix pass
- `settings.ai-agents` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-ai-agents/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Agent chats" (web ok; gpuix ok via text); present "Close idle chats after": web pass, gpuix pass
- `settings.skills` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-skills/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Skills" (web ok; gpuix ok via text); present "Skills": web pass, gpuix pass
- `settings.provider` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-provider/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Accounts" (web ok; gpuix ok via text); present "1 account": web pass, gpuix pass
- `settings.mcp-servers` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-mcp-servers/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "MCP servers" (web ok; gpuix ok via text); present "MCP servers": web pass, gpuix pass
- `settings.shortcuts` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-shortcuts/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Keyboard shortcuts" (web ok; gpuix ok via text); present "Command Palette": web pass, gpuix pass
- `settings.diagnostics` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-diagnostics/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Logs" (web ok; gpuix ok via text); present "Application log": web pass, gpuix pass
- `settings.reset` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/settings-reset/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Reset" (web ok; gpuix ok via text); present "Reset all settings": web pass, gpuix pass
- `palette.open` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: press ctrl-k (web ok; gpuix ok via key); present "App Preferences": web pass, gpuix pass; present "New Terminal": web pass, gpuix pass
  - `c-filter`: type "theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `d-escape`: press escape (web ok; gpuix ok via key); gone "Change Color Theme": web pass, gpuix pass
- `palette.type-ahead` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-type-ahead/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-typed`: press ctrl-k (web ok; gpuix ok via key); type "theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
- `palette.new-terminal` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-new-terminal/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "New Terminal" (web ok; gpuix ok via key); present "New Terminal": web pass, gpuix pass
  - `c-run`: click "New Terminal" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Terminal": web pass, gpuix pass
- `palette.agent-launcher` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-agent-launcher/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Agent Launcher" (web ok; gpuix ok via key); present "Agent Launcher": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Agent Launcher" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Chat Scenario Agent": web pass, gpuix pass
- `palette.save-snapshot` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-save-snapshot/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Save Workspace Snapshot" (web ok; gpuix ok via key); present "Save Workspace Snapshot": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Save Workspace Snapshot" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Snapshot": web pass, gpuix pass
- `palette.open-canvas` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-open-canvas/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Open Canvas" (web ok; gpuix ok via key); present "Open Canvas": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Open Canvas" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Canvas": web pass, gpuix pass; present "Ready": web pass, gpuix pass
- `palette.project-settings` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-project-settings/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Project Settings" (web ok; gpuix ok via key); present "Project Settings": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Project Settings" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Basic project identification and location.": web pass, gpuix pass
- `palette.app-preferences` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-app-preferences/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "App Preferences" (web ok; gpuix ok via key); present "App Preferences": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "App Preferences" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Interface zoom": web pass, gpuix pass
- `palette.switch-project` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-switch-project/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "beta" (web ok; gpuix ok via key); present "beta": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: press enter (web ok; gpuix ok via key); wait 1200 ms (web ok; gpuix ok via none); present "What should we do in beta?": web pass, gpuix pass; present "Chat Scenario Agent": web pass, gpuix pass; gone "Loading model…": web pass, gpuix pass; gone "Composer unavailable": web pass, gpuix pass
- `palette.command-history` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-command-history/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Command History" (web ok; gpuix ok via key); present "Command History": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Command History" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Command History": web pass, gpuix pass
- `palette.color-theme` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-color-theme/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Change Color Theme" (web ok; gpuix ok via key); present "Change Color Theme": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Change Color Theme" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Dracula": web pass, gpuix pass
- `palette.shortcut-menu` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-shortcut-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Open Shortcut Menu" (web ok; gpuix ok via key); present "Open Shortcut Menu": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Open Shortcut Menu" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Shortcut Menu": web pass, gpuix pass
- `palette.report-bug` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/palette-report-bug/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-filtered`: press ctrl-k (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); type "Report a Bug" (web ok; gpuix ok via key); present "Report a Bug": web pass, gpuix pass; gone "New Terminal": web pass, gpuix pass
  - `c-run`: click "Report a Bug" (web ok; gpuix ok via text); wait 1200 ms (web ok; gpuix ok via none); present "Report a bug": web pass, gpuix pass
- `shortcuts.menu` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/shortcuts-menu/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Open keyboard shortcuts menu] (web ok; gpuix ok via web-point); present "Shortcut Menu": web pass, gpuix pass
- `shortcuts.settings-shortcut` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/shortcuts-settings-shortcut/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: press alt-, (GPUIX ctrl-,) (web ok; gpuix ok via key); present "Interface zoom": web pass, gpuix pass
  - `c-escape`: press escape (web ok; gpuix ok via key); wait 600 ms (web ok; gpuix ok via none); gone "Interface zoom": web pass, gpuix pass
- `shortcuts.toggle-projects` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/shortcuts-toggle-projects/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-shift-b (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "gamma": web pass, gpuix pass
- `shortcuts.toggle-side-panel` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/shortcuts-toggle-side-panel/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-b (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "Explorer": web pass, gpuix pass
- `shortcuts.theme-picker` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/shortcuts-theme-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press ctrl-alt-t (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "Color Themes": web pass, gpuix pass
- `shortcuts.zoom-in` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/shortcuts-zoom-in/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-pressed`: click "Projects" (web ok; gpuix ok via text); press alt-= (GPUIX ctrl-=) (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `shortcuts.desktop-keymap` (frames `/root/termul-wt/gpuix-r5/apps/gpuix/parity-out/matrix/shortcuts-desktop-keymap/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-terminal`: click button[aria-label^="Open terminal at"] (web ok; gpuix ok via web-point); wait 2500 ms (web ok; gpuix ok via none); present "Terminal 1": web pass, gpuix pass; gone "What should we do in alpha?": web pass, gpuix pass
  - `c-launcher`: click "Projects" (web ok; gpuix ok via text); press ctrl-t (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
  - `d-launcher-again`: click "Projects" (web ok; gpuix ok via text); press ctrl-t (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); gone "What should we do in alpha?": web pass, gpuix pass
  - `e-close-tab`: click "Projects" (web ok; gpuix ok via text); press ctrl-w (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none); present "Close Terminal": web pass, gpuix pass
  - `f-closed`: click "Close" (web ok; gpuix ok via text); wait 1000 ms (web ok; gpuix ok via none); gone "Terminal 1": web pass, gpuix pass
  - `g-history`: click "Projects" (web ok; gpuix ok via text); press ctrl-r (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); present "Command History": web pass, gpuix pass
  - `h-settings`: press escape (web ok; gpuix ok via key); click "Projects" (web ok; gpuix ok via text); press ctrl-, (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); present "Interface zoom": web pass, gpuix pass
  - `i-zoom`: press escape (web ok; gpuix ok via key); click "Projects" (web ok; gpuix ok via text); press ctrl-= (web ok; gpuix ok via key); wait 1000 ms (web ok; gpuix ok via none)
- `theme.picker` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-picker/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Color themes] (web ok; gpuix ok via web-point); present "Dracula": web pass, gpuix pass; present "Nord": web pass, gpuix pass
- `dialogs.bug-report` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/dialogs-bug-report/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Report a bug] (web ok; gpuix ok via web-point); present "Report a bug": web pass, gpuix pass
- `canvas.open` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/canvas-open/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Open canvas] (web ok; gpuix ok via web-point); present "Canvas": web pass, gpuix pass; present "Ready": web pass, gpuix pass
- `browser.pane` (frames `/root/termul-wt/gpuix-r5/apps/gpuix/parity-out/matrix/browser-pane/`):
  - `a-dashboard`: wait 2000 ms (tauri ok via none; gpuix ok via none); present "What should we do in alpha?": tauri frame only, gpuix pass
  - `b-page`: press ctrl-shift-n (tauri ok via key; gpuix ok via key); wait 2500 ms (tauri ok via none; gpuix ok via none); click @800,63 (tauri ok via point; gpuix ok via point); wait 600 ms (tauri ok via none; gpuix ok via none); press ctrl-a (tauri ok via key; gpuix ok via key); type "http://127.0.0.1:8289/reference" (tauri ok via key; gpuix ok via key); press enter (tauri ok via key; gpuix ok via key); wait 3000 ms (tauri ok via none; gpuix ok via none); present "R5 reference page": tauri frame only, gpuix pass
- `notifications.toast` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/notifications-toast/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-picker`: click [Switch git branch] (web ok; gpuix ok via web-point); click "Create branch from" (web ok; gpuix ok via text)
  - `c-toast`: type "toast-branch" (web ok; gpuix ok via key); press enter (web ok; gpuix ok via key); wait 800 ms (web ok; gpuix ok via none); present "Created and checked out toast-branch": web pass, gpuix pass
- `ssh.workspace` (frames `/root/termul-wt/gpuix-r5/apps/gpuix/parity-out/matrix/ssh-workspace/`):
  - `a-sidebar`: present "What should we do in alpha?": web pass, gpuix pass; present "staging": web pass, gpuix pass; present "build-box": web pass, gpuix pass
  - `b-hosts`: click [Open SSH hosts] (web ok; gpuix ok via web-point); present "Favorites": web pass, gpuix pass; present "Servers": web pass, gpuix pass
  - `c-new-host`: click [New host] (web ok; gpuix ok via web-point); present "New host": web pass, gpuix pass
- `settings.accounts-claude` (frames `/root/termul-wt/gpuix-r5/apps/gpuix/parity-out/matrix/settings-accounts-claude/`):
  - `a-dashboard`: present "What should we do in alpha?": web pass, gpuix pass
  - `b-open`: click [Settings] (web ok; gpuix ok via web-point); present "Interface zoom": web pass, gpuix pass
  - `c-section`: click "Accounts" (web ok; gpuix ok via text); present "1 account": web pass, gpuix pass; present "Keep work and personal apart": web pass, gpuix pass
  - `d-add`: click "Add account" (web ok; gpuix ok via text); wait 800 ms (web ok; gpuix ok via none); type "Work" (web ok; gpuix ok via key); present "Give it a short name. Termul shows this name, never the email.": web pass, gpuix pass
- `update.toast`: pending U1 GPUIX updater and what's new: GPUIX has neither (App.tsx renders WhatsNewModal and UpdateAvailableToast only under isTauriContext()); the reference is the desktop app, which shows the toast against a release feed and the modal after a version change
- `snapshots.page` (frames `/root/termul-wt/gpuix-r5/apps/gpuix/parity-out/matrix/snapshots-page/`):
  - `a-page`: present "Workspace Snapshots": web pass, gpuix pass; present "Create New Snapshot": web pass, gpuix pass; present "No snapshots yet": web pass, gpuix pass
  - `b-create`: click "Create New Snapshot" (web ok; gpuix ok via text); present "Create Snapshot": web pass, gpuix pass
- `theme.termul-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-termul-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.termul-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-termul-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.cursor-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-cursor-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.cursor-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-cursor-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.catppuccin-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-catppuccin-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.catppuccin-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-catppuccin-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.dracula-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-dracula-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.dracula-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-dracula-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.nord-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-nord-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.nord-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-nord-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.gruvbox-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-gruvbox-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.gruvbox-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-gruvbox-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.tokyonight-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-tokyonight-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.tokyonight-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-tokyonight-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.ayu-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-ayu-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.ayu-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-ayu-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.one-dark-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-one-dark-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.one-dark-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-one-dark-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.github-dark` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-github-dark/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass
- `theme.github-light` (frames `/root/termul-wt/gpuix-g13/apps/gpuix/parity-out/matrix/theme-github-light/`):
  - `a-dashboard`: wait 800 ms (web ok; gpuix ok via none); present "What should we do in alpha?": web pass, gpuix pass

<!-- matrix:end -->
