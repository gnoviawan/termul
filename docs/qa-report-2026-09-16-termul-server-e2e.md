# QA Report — termul-server E2E & Mobile UX Design Audit (2026-09-16/17 round)

**Date:** 2026-09-16/17
**Target:** freshly built `termul-server` debug binary (HEAD, `cargo build --bin termul-server --features standalone-server`) + `bun run build:web` (`dist-web/`), run isolated on `127.0.0.1:8082` with `--state-dir /tmp/termul-e2e/state`.
**Method:** three e2e passes in headless Chromium (Playwright chromium-1228, CDP):
1. **Desktop functional walkthrough** at 1440×900 — project create, terminal PTY round-trips, git stage→commit→log (verified on-disk), editor create/edit/save, snapshots, themes, command palette, browser tab.
2. **Mobile-first functional pass** — booted at 390×844 / DPR 3 with a clean profile; touch key bar, git sheet, file explorer, snapshots, project switching; viewport matrix 320–768 + landscape.
3. **Mobile design/layout audit** at 390×844 / DPR 3 across 9 surfaces — screenshots + DOM geometry (`getBoundingClientRect`) + computed styles, **in parallel** with two source-analysis scouts (design-token consistency, mobile flow gaps) whose claims were each spot-verified in-repo before inclusion.

PTY round-trips verified via DOM-rendered xterm output + server logs; git flows verified on-disk in the real repos under `/tmp/termul-e2e/`.
**Environment note (same as 2026-09-15 round):** Obscura cannot host these UI tests — page-side WS receive is broken; all results come from real Chromium.
**Not touched:** the operator's live systemd `termul-server` on `0.0.0.0:8080` (healthy before/after; the first launch actually lost the port race to it — hence the isolated 8082 run).
**Terminal renderer note:** passes 2–3 used the DOM renderer (`terminalRenderer: 'dom'`) because the default WebGL renderer paints blank at DPR ≥ 3 — that is itself finding F0/P0 below, not a test-environment artifact.

---

## Verdict

The **core pipeline is solid**: project create/persist, terminal spawn→write→output (desktop + mobile + after project switch + after reload with re-layout), git stage/commit/log all verified against real on-disk state; snapshots persist; themes apply; command palette works; layout restores after reload. **Contrast and typography are in good shape** (fg 15.35:1, muted 7.16:1 — AAA; 16/14px scale; no horizontal overflow at any width 320–767). The defects concentrate in four areas: **(1) render — WebGL fails at phone pixel densities; (2) mobile interaction gaps — no editor save, hover-only actions, navigation traps, Escape-dependent dismissal; (3) touch ergonomics — no 44px target floor, dead safe-area insets; (4) redundancy/UI drift — duplicated actions, token inconsistency.**

---

# Part I — Functional E2E Findings

## P0 — WebGL terminal paints blank at DPR ≥ 3 (mobile-blocking)
- **Repro:** boot the web client with mobile emulation `deviceScaleFactor: 3` (any real phone), default `terminalRenderer: 'webgl'` (`types/settings.ts:245`). Terminal area renders **zero bright pixels** (pixel-verified from raw frame dumps) while the PTY is fully alive underneath — typed input executes, output accumulates in the buffer, server log shows the write frames.
- **Isolation:** WebGL context is healthy (`WebGL 2.0`, maxTex 8192); canvas backing store is correctly sized (342×722 CSS → 1025×2166); a viewport-change "resize nudge" does NOT recover it (unlike the DPR *change* case below). Switching `terminalRenderer` to `'dom'` renders everything perfectly at the same DPR.
- **Impact:** every default-configured phone shows a dead terminal. Users type blind — commands DO run.
- **Mitigation (1 line):** default `terminalRenderer: 'dom'` when `useMobileWebShell()`; root fix in the xterm WebGL painter's high-DPR path.

## P1 — WebGL canvas goes stale on DPR *change* (desktop + mobile)
- Viewport DPR 1→3 (zoom, monitor switch, phone rotation) leaves the text-layer canvas backing store at the old scale (measured 1025×2166 backing for 342px CSS) → blank until an explicit resize event. Same class of bug as P0, different trigger.

## P1 — Preserved PTYs are never reattached on reload
- Server logs `client disconnected; N PTY(s) preserved` but the client **spawns a new PTY** on reload instead of reattaching; scrollback is lost and the "preserved" PTYs leak until orphan cleanup (which is itself failing — see next).
- Verified live: after reload, `echo AFTER_RELOAD` went to a *new* terminal id (server log).

## P1 — `update_orphan_detection` always UNAUTHORIZED on web (settings never apply)
- Every client boot sends `update_orphan_detection` immediately after connect; server refuses (`terminal_ws.rs:555-560` requires ≥1 *attached* terminal; the settings push fires pre-attach from `use-app-settings.ts:187`). Orphan-detection settings silently never apply on web — compounding the PTY leak above.
- **Fix:** defer the settings push until first attach, or allow it on authed connections.

## P1 — Web editor has no working save path (data loss)
- Desktop: typed content stays 0 bytes until Ctrl+S (autosave debounce never flushes to the server). Mobile: **no save button exists at all** (EditorToolbar has only TOC/Source toggles) and phones have no Ctrl key → edits are unrecoverable. Verified twice (desktop notes.md; mobile README.md "mobile edit line" never reached disk after 8s).
- **Fix:** add a save affordance to the mobile editor header + fix the web autosave path.

## P1 — Rail buttons accumulate duplicate panes
- Every click on "Open git changes"/"git history" appends a new tab: 4 clicks → 4 identical "Git Changes" tabs each with its own badge (live-reproduced; screenshot evidence).
- **Root cause:** `WorkspaceLayout.tsx:1064` `handleAddGitTab` mints `git-${randomUUID()}` per call while `addTabToPane` dedupes by that always-unique `tab.id`.
- **Fix:** reuse/activate existing tab by `(type, cwd)` — the pattern `addBrowserTab`/`addEditorTab` (`workspace-store.ts:810,789`) already use.

## P1 — Mobile navigation traps: non-terminal tabs are one-way
- Live-reproduced: open **Git History** from the header → no close, no back, not listed in the drawer; the only escape is tapping a terminal entry in the drawer. Source: `PaneContent.tsx:214` hides the tab bar on mobile; `MobileChatShell.tsx:100` drawer filters `type==='terminal'` only — **editor, git, git-history, browser tabs all trap**. The editor dirty-dot and unsaved-changes guard (`WorkspaceLayout.tsx:1489`) live only in the hidden tab bar.
- Also: no mobile path to create a 2nd+ project (switcher drawer lists only; palette has no New Project; only the zero-project empty state has a CTA), and `NewProjectModal.tsx:378` is fixed `w-[520px]` — **overflows every phone** on that only path.

## P2 — Hover-only actions unreachable on touch
- GitPanel stash apply/pop/drop: `opacity-0 group-hover:opacity-100` (`GitPanel.tsx:966`) — invisible AND untappable on touch; row actions 24×24; mobile diff omits per-hunk stage/unstage props (desktop passes them at `:1704`).
- Snapshot card rename/delete same hover pattern (`WorkspaceSnapshots.tsx:264`) and **Rename has no onClick at all** (dead control).

## P2 — Escape-dependent dismissal on a keyboard-less platform
- Live-tested: the Preferences dialog does not close on Escape (2 attempts); ~38 components dismiss via Escape only; **zero popstate/hardware-back handlers exist in the renderer** (grep-verified). Android back exits the app instead of closing an overlay.

## P2 — Landscape phone gets the full desktop shell
- 844×390 (width > 767 breakpoint) → desktop IDE chrome; ~3–4 terminal lines visible (266px). Breakpoint is width-only; height ignored.

## P2 — Diagnostics noise pollutes the frontend-error channel
- `WsAcpTransport.reconnect: WebSocket closed before auth` every ~68s forever when no agent session is active (idle `/ws` killed by the 75s PONG watchdog mid-auth); `persistence queue rejected … persisted session not found` warnings; shutdown-time `[acp] failed to finalize N persisted session(s)` errors. All user-invisible but drown real errors in `/log/frontend-error`.

## P3 — Redundant UI
- Duplicate snapshot create buttons (header "Create New Snapshot" + empty-state "Create First Snapshot") shown simultaneously.
- Project name displayed 4× at once on desktop (title bar, sidebar, context bar, h1), 6× on mobile — plus the sidebar truncates while the h1 wraps mid-word.
- Desktop-only prefs render ungated on web: "Check for Updates" + auto-update + "Reveal Log Folder"/"Export Log File…" (`AppPreferences.tsx:1237` not gated while :901/:937/:972/:1010 are) — the button silently no-ops. ACP timeout settings carry "Desktop only" in their descriptions yet render editable.
- "New Browser Tab" offered on web then fails (`browserTabCreate rejected: Tauri invoke unavailable`) → blank pane. Gate it (repo convention: `isTauriContext()` + test the unsupported state).
- Doubled-name creation trap: NewProjectModal auto-derives the name from the path, and typing on top of the auto-filled value silently concatenates (`demo-projectdemo-project` — persisted to the registry; reproduced deliberately). At minimum warn on doubled names.

## Verified working (no findings)
- **Project lifecycle:** create (modal + empty-state CTA), scaffold, persist to `projects.json`, list, switch (desktop + mobile drawer); PTYs preserved across switches (per AGENTS.md invariant).
- **Terminal:** spawn/attach/resize/write/kill round-trips at DPR 1 (desktop + mobile); touch key bar fully functional (Ctrl+C interrupts, Tab completes, arrows recall history — verified byte-identical to physical keyboard); layout + browser-tab restore after full reload.
- **Git (web):** status/branch/stash-list/diff/stage/commit/log all correct; commit `cdbc3a4` verified in the real repo; history panel reflects it; detached-HEAD → branch transitions.
- **Editor:** file create via explorer inline input; open; edit; Ctrl+S → exact content on disk (desktop).
- **Snapshots:** create + list + persist to server store (mobile).
- **Command palette:** filter → execute (Save Workspace Snapshot).
- **Theme picker:** apply instant (Dracula bg verified).
- **Viewport matrix:** no horizontal overflow at 320/360/390/414/767; 767/768 mobile↔desktop shell breakpoint flips exactly.
- **Mobile sheets:** git sheet (list → diff, green added-line highlight), file explorer (44px rows), chat drawer structure.

---

# Part II — Mobile UX Design & Layout Audit (390×844)

## Strengths to keep
- **Contrast is excellent**: foreground 15.35:1, muted 7.16:1 on the Dracula background — AAA territory. Dark-theme legibility is not a risk.
- **Base typography sane**: 16px body / 14px labels, Inter Variable bundled and actually used.
- **File explorer sheet** is the quality bar: 44px rows (the only compliant list), `truncate` everywhere, clean title/subtitle/toolbar hierarchy.
- **No horizontal overflow at any width** 320–767; the 767/768 mobile↔desktop shell breakpoint flips exactly.
- **Bottom safe-area is already modeled** (key bar `pb-[max(0.5rem,env(safe-area-inset-bottom))]`) — it just needs the viewport meta to work (F2).
- **Chat drawer structure** is right: title → primary action → sections → search → empty state with guidance.

## F1 — Touch targets: no 44px floor exists anywhere in the system (HIGH)
Live: 13/13 interactive elements on the agent launcher are < 44px (agent/model selects **24px**, attach/close 32px, send 34px, header 40px). Source: the button cva tops out at `h-10` (40px) for icon/default sizes (`button.tsx:21-28`) — **no ≥44px variant exists**, so every `size="icon"` in a mobile path is ≤40px. Worst offenders: GitPanel mobile row actions `h-6 w-6` (24px) on every staged/unstaged row, stash buttons `h-5 w-5` (20px), diff-mode toggles 28px, EditorToolbar TOC/Source tabs `h-6` (24px), Radix Sheet default close X ~16px (`sheet.tsx:67`).
**Fix:** add a `touch` size to the button cva (h-11 visual + `after:-inset-1.5` hit-slop) and promote the existing hit-slop idiom — currently used in exactly two components (`AttachFilesButton.tsx:29-31`, `ChatHistoryEntryRow.tsx:74-80`, both with explanatory comments) — to the app-wide pattern. Visual density stays; hit areas become 44–48px.

## F2 — Safe-area: one meta tag disables every inset (HIGH, 1-line root fix)
`index.html:11-14` viewport meta is `width=device-width, initial-scale=1.0, interactive-widget=resizes-content` — **missing `viewport-fit=cover`**, so `env(safe-area-inset-*)` evaluates to 0 on iOS/Android cutout devices. The single existing inset usage (key bar bottom) is a no-op, and no component insets the top: the h-12 mobile header (`MobileChatShell.tsx:160`) puts 40px buttons at y=4, under the notch/Dynamic Island.
**Fix:** add `viewport-fit=cover` to the meta; add `pt-[env(safe-area-inset-top)]` to the mobile shell root (`WorkspaceLayout.tsx:1864`).

## F3 — Navigation traps: non-terminal tabs are one-way dead ends (HIGH)
Same root as the P1 functional finding, from the design angle: live-reproduced Git History trap (no close/back, drawer lists only Terminals + Chats). The editor dirty dot (`EditorTab.tsx:65`) and the unsaved-changes close guard (`WorkspaceLayout.tsx:1489-1505`) are only invokable from the hidden bar; an opened file is only re-reachable by re-opening it from the file explorer.
**Fix:** list all pane tabs in the drawer (with close affordance + dirty dot), or render a compact mobile tab strip when >1 non-terminal tab exists.

## F4 — Hover-only actions are invisible and unreachable on touch (HIGH)
- GitPanel stash apply/pop/drop: `opacity-0 group-hover:opacity-100` (`GitPanel.tsx:966`) — invisible AND untappable on touch.
- Snapshot card rename/delete: same pattern (`WorkspaceSnapshots.tsx:264`); **Rename has no onClick handler at all** (dead control).
- Mobile diff view omits the per-hunk stage/unstage props desktop passes (`GitPanel.tsx:799` vs `:1704-1705`).
**Fix:** always-visible 44px actions or long-press context menus; wire or delete the dead Rename.

## F5 — Escape-dependent dismissal on a platform without Escape (HIGH)
Live-tested: the Application Preferences dialog does **not** close on Escape (tried twice). The AgentLauncher overlay is Escape-or-X only (`PaneContent.tsx:455-461`). No `popstate` handlers exist in the renderer — Android hardware-back exits the app instead of closing the topmost sheet/dialog.
**Fix:** guarantee a visible close control on every overlay (Radix sheets mostly have it; verify prefs); add a `popstate` listener that closes the topmost overlay before the app exits.

## F6 — Fixed-width creation modal overflows every phone (HIGH, 1 line)
`NewProjectModal.tsx:378`: `w-[520px]` with no responsive max — overflows 390px on the **only** mobile project-creation path (the zero-project empty-state CTA; the drawer/switcher/palette offer no creation entry).
**Fix:** `w-[520px] max-w-[calc(100vw-2rem)]`.

## F7 — Token drift across the mobile surface family (MEDIUM)
- **Spacing:** GitPanel mobile uses p-3/px-3/gap-3 (`GitPanel.tsx:737,806,1053,2022`) while every other mobile sheet uses p-2/gap-1-2; sheet headers mix `px-4 py-3` (MobileChatShell:286) / `px-3 py-3` (MobileFileExplorer:423) / `px-3 py-2` (action sheet :568).
- **Radius:** mobile overlays use rounded-t-xl (12px, file-explorer action sheet), rounded-2xl (16px, SelectorModal), `sm:rounded-xl` (Dialog), `sm:rounded-lg` (AlertDialog), and the git bottom sheet has **no radius** (full-screen takeover measured: y=0, h=844).
- **Color:** `destructive`/`success`/`warning` tokens exist (`tailwind.config.ts:47-100`) but mobile paths use raw `bg-red-500`/`text-red-400`/`amber-500`/`green-*` (e.g. `MobileFileExplorer.tsx:626`, `GitPanel.tsx:1021-1037`, `WorkspaceSnapshots.tsx:256,332`).
- **Sub-12px text carries primary content:** text-4xs = 9px (git filenames `GitPanel.tsx:2032`), text-3xs = 10px (stash labels, agent statuses), and an 11px **clickable** amend label at ~2.5:1 contrast when disabled (`GitPanel.tsx:1090-1093`). The tailwind config comment says these are for "captions/badges/micro-labels" — they're rendering filenames and controls.

## F8 — Terminal typography ignores the bundled font (MEDIUM)
Default `terminalFontFamily` is `'Menlo, Monaco, "Courier New", monospace'` (`types/settings.ts:242`) — **none exist on Android/iOS browsers**, so xterm falls back to a generic system font (live-observed Inter fallback at 16px) while the bundled **JetBrains Mono Variable** (`index.css:2-3` via @fontsource) is never referenced. Terminal keeps desktop `px-4` (16px) horizontal padding at mobile widths (`ConnectedTerminal.tsx:1925`) → ~40 columns at 390px.

## F9 — Overlay ergonomics (MEDIUM)
- **Agent launcher** floats centered with large dead space above/below; the composer crams textarea + 24px selects + 34px send into one 148px box (`AgentLauncher.tsx:1519-1520` launch button `size-[34px]`; `ComposerPill.tsx:21-32` selects ~24px). Bottom-anchor the composer to the thumb zone; the mobile SelectorModal picker pattern (`:1896-1907`) is already correct — the triggers are the problem.
- **Git sheet** is full-screen with radius 0; the commit footer stacks 4 equal-weight buttons (Generate message / Amend / Commit / Publish) — "Publish branch" belongs in overflow when no upstream, "Generate message" is a sparkle inside the summary field, "Amend" is a checkbox in an advanced section. The sheet sits flush against the home indicator (no bottom inset, `WorkspaceLayout.tsx:1918`).
- **Command palette** renders top-anchored (thumb-unreachable), shows desktop key hints (`ctrl+t`, `↵ SELECT`, `ESC CLOSE`) that are dead affordances on touch, and offers no visible close.
- **Header**: up to 7 equal-weight icon buttons + truncating title in h-12; no overflow menu. On 360–375px the title truncates to ~0 when a terminal is active.
- **Toasts**: Radix viewport is `fixed top-0` full-width on mobile (`toast.tsx:17`) — collides with the header; Sonner stacks collapsed at the bottom with `expand=false` (hover-only expansion, `sonner.tsx`) directly over the terminal key bar, so queued toasts stay hidden on touch. StatusBar (connection health, exit codes) is not rendered on mobile at all (`WorkspaceLayout.tsx:1675`).

## F10 — Snapshots page has no mobile branch (MEDIUM)
`WorkspaceSnapshots.tsx` never uses `isMobileWebShell` despite routing under the mobile shell: h1 is an un-truncated flex row whose anonymous text wraps mid-word (`:147-152`), desktop `h-14 px-6`/`p-6` rhythm, ~33px-tall create buttons (`:154-160`), the `/` separator uses `text-border` (near-invisible), and the project name renders **again** below the shell header's copy of it (doubled name).

## F11 — Markdown editor misses the mobile TOC gate the code editor has (MEDIUM)
`CodeEditor.tsx:98` gates `canRenderToc` with `!isMobileWebShell` (documented rationale); `MarkdownEditor.tsx:188` is `isTocHydrated && isTocVisible` — **missing the gate**, so toggling TOC on a 375px phone squeezes BlockNote to ~225px beside a 150px TOC. EditorToolbar (`EditorToolbar.tsx:31-51`) leaks desktop `h-6` tabs into the mobile pane.

## F12 — Copy/consistency (LOW)
- Project switcher: "Switch the shared session to a **desktop** project" (desktop terminology on mobile).
- Empty-state case mismatch: "Start one with the New Chat button" vs the actual "New chat" button.
- Drawer width `w-[min(100vw-3rem,20rem)]` = 320px = 82% of a 390px viewport — wide enough to feel like a page-jump; ~70–75% reads better as a drawer.
- Search sits below the Terminals section while labeled "Search chats…" — scope confusion.
- AgentLauncher non-auth failures (spawn/transport/timeout) surface only as a "Setup failed" pill whose Retry is buried in the model-picker modal (`AgentLauncher.tsx:2089-2126`); only auth failures get an in-flow actionable banner (`:1373-1384`).

---

# Improvement Plan (merged, effort-ordered)

| # | Fix | Where | Effort | Resolves |
|---|---|---|---|---|
| 1 | `viewport-fit=cover` + mobile shell top inset | `index.html:11`, `WorkspaceLayout.tsx:1864` | 1 line each | F2 |
| 2 | NewProjectModal responsive width | `NewProjectModal.tsx:378` | 1 line | F6 |
| 3 | Mobile DOM-renderer default (until WebGL fix) | `settings.ts:245` or spawn path | 1 line | P0 |
| 4 | MarkdownEditor mobile TOC gate | `MarkdownEditor.tsx:188` | 1 line | F11 |
| 5 | Button cva `touch` size + hit-slop idiom rollout | `button.tsx:21`, mobile components | ~2 h | F1 |
| 6 | Touch-visible stash/snapshot actions; wire dead Rename | `GitPanel.tsx:966`, `WorkspaceSnapshots.tsx:264` | ~2 h | F4 |
| 7 | Mobile editor save affordance + web autosave fix | editor toolbar + save path | ~½ day | P1 save |
| 8 | `popstate` hardware-back overlay dismissal; visible close everywhere | renderer root | ~½ day | F5 |
| 9 | Drawer lists all tabs (+ close/dirty) — kills nav traps | `MobileChatShell.tsx:100`, `PaneContent.tsx:214` | ~1 day | F3/P1 traps |
| 10 | Defer `update_orphan_detection` until first attach; PTY reattach on reload | `use-app-settings.ts:187`, reconnect path | ~½ day | P1×2 |
| 11 | Duplicate-tab reuse by `(type, cwd)` | `WorkspaceLayout.tsx:1064,1086` | ~1 h | P1 dupes |
| 12 | JetBrains Mono terminal default; sub-12px text cleanup | `settings.ts:242`, git/launcher labels | ~2 h | F8, F7 (text) |
| 13 | WorkspaceSnapshots mobile branch (truncate h1, spacing, single CTA) | `WorkspaceSnapshots.tsx` | ~½ day | F10 |
| 14 | Token sweep: spacing/radius/color unification | mobile sheets | sweep | F7 |
| 15 | Launcher composer bottom-anchor + selector/send redesign | `AgentLauncher.tsx` | ~1 day | F9 |
| 16 | Toast position + touch expansion; mobile StatusBar | `toast.tsx`, `sonner.tsx` | ~½ day | F9 (toasts) |
| 17 | Landscape: `height < 500 && width > 767` keeps mobile shell | `use-mobile-web-shell.ts` | 1 line | P2 landscape |
| 18 | Gate desktop-only prefs + Browser Tab on web | `AppPreferences.tsx`, `PaneContent.tsx` | ~1 h | P3 redundancy |
| 19 | WebGL high-DPR root fix (replaces #3) | xterm WebGL painter | investigation | P0, P1 DPR-change |

Order rationale: items 1–4 are one-liners with outsized impact; 5–8 are the touch-ergonomics core; 9–11 fix data-loss and traps; the rest is polish and the deep render fix.

## Evidence index
- Test state: `/tmp/termul-e2e/` (state dir with projects.json/store.json, demo-project + beta repos).
- Screenshots: `/tmp/omp-sshots-15821*` (desktop pass), `/tmp/omp-sshots-15826*` (mobile pass), `/tmp/omp-sshots-15827*` (design pass).
- Server logs: captured via hub during all passes (spawn/attach/write/git/ACP frames quoted inline above).
- Source audit outputs: `agent://TokenAudit`, `agent://FlowAudit` (parallel scouts; claims spot-verified in-repo, including live reproduction of the Git History trap).
- Related prior round: `qa-report-2026-09-15.md`.
