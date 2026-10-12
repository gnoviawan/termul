# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features
- **Server** — The web boundary for fs writes from remote peers, git, worktree, search, skills and canvas is now "inside any registered, non-archived project" (cached canonical roots, revalidated on use) instead of one rebindable host root: a phone can work in any registered project, outside every project returns `OUTSIDE_PROJECT_ROOT`, and moving the host default no longer moves the boundary. A synthetic project is seeded from `--project-root` (or the desktop default/home) only while no usable project is registered and is retired when a real one is added. `fs_changed` is now per project: connections send `watch_project`/`unwatch_project` and receive `fs_changed{projectId,root,paths}` only for the projects they watch (refcounted watcher per project, dropped on last unsubscribe, disconnect, or project archive/remove, which also sends `fs_watch_ended`)
- **ACP** — `list_agents` replies carry each live agent's owned-session set (`ownsSession`), so a reloading web client can reuse the host agent that owns a session instead of spawning a duplicate (#837)
- **Server** — Standalone `termul-server` idle agent reaper: agents with no durable session, live turn, or WS subscriber for the window (default 15 min, `TERMUL_AGENT_IDLE_REAP_SECS` override) are disposed and stopped, with tracing reap logs (#837)
- **Server** — One host per data path: the desktop and `termul-server` take an exclusive `File::try_lock` lock on a sidecar (`.termul.lock` in directory stores, `<file>.lock` beside `store.json`/`projects.json`) before opening any store; a second host refuses to start and names the path and, when available, the rival pid. The sidecar is never followed through a symlink
- **Server** — `store.json` is versioned (`{"schemaVersion":1,"data":{…}}`): a legacy bare map is backed up to `store.json.pre-v1-<ts>.bak` before it is migrated, a newer `schemaVersion` is refused and the file left untouched, unknown top-level keys survive rewrites, and the 10 MiB write limit applies to the data payload. Migration backups (including `projects.json.pre-v3-<ts>.bak`) are created owner-only (`0600`) on Unix
- **ACP** — The workspace manifest, ACP catalog and install stores refuse to open a file written by a newer schema instead of overwriting it
- **Desktop** — Shared-live mode serves the desktop's own `store.json` from the desktop data folder, so the desktop and the shared web client see one store
- **Desktop** — A tunnelled shared-live host now requires the bearer token for HTTP, and the shared tunnel link carries `#token=<token>` so the browser can authenticate; the bare tunnel URL is never shared alone

### Bug Fixes
- **Web** — Client transport hygiene (#1065): returning from the background probes the held `/ws` socket and reconnects only if the probe fails (no forced reconnect after 30 s hidden); `/ws`, `/terminal/ws` and the persistence socket each time out a stalled upgrade/authenticate at ~10 s (persistence callers and `flushPendingWrites` no longer hang); reconnect backoff is exponential with ±25 % jitter, reset only after 60 s of stable connection, and wake/online/focus cut a pending backoff short; request timers are per type (install ≥ 330 s, catalog refresh/session open ≥ 90 s); one failing session resubscribe retries and degrades alone instead of tearing the socket down; a terminal re-attach that times out on an open socket recycles the connection instead of buffering input forever
- **Chat** — A prompt whose reply is lost to a dropped connection stays open as a non-error "Waiting to confirm…" state and is resent with the SAME turn id after reconnect (only an explicit server rejection fails it); prompt receipts never end a turn; `error`/`timeout`/`crashed` turn terminators end the turn idempotently; transcript flushes are tiered (watched session ≤ ~30 ms on rAF, background ~100 ms, approvals/questions immediate, all on `visibilitychange`); an open code fence larger than 8 000 chars is no longer re-highlighted in full on every commit (highlighted once when the fence closes) (#1065).
- **ACP** — A resend of a prompt with the same `turnId` (web `send_prompt` and desktop `acp_send_prompt`) returns an `in_progress`/`accepted` receipt instead of `rate_limited`/`stale`; every accepted turn ends with exactly one `prompt_complete` (new `error`, `timeout` and `crashed` stop reasons); the durable `user_prompt` is sequenced when the driver accepts the prompt, so it is never delivered after a chunk of its turn and a rejected prompt leaves no record (#1065)
- **Server** — `POST /mcp-servers/probe` and `POST /acp/factory-key` now require the same write posture as every other mutation route; the idle agent reaper disposes only ephemeral sessions and now reaps idle durable-session agents; a terminal re-attach releases the previous attachment; session JSONL records are written in one write and a valid but unterminated tail is repaired on open; detaching a web-listed PTY re-stamps its listing time (#1065)
- **ACP** — `session/load`/`session/resume` on a session owned by a DIFFERENT live agent mid-turn are rejected (`session_owned_by_other`) instead of creating a split-brain where both agents accept prompts (#837)
- **ACP** — Web page load no longer prewarms a default agent: selection defaults to configured agents only and the launcher prepares a process only for a configured agent on composer open — Codex `npx` trees are no longer spawned on every reload (#840)
- **ACP** — Agent `browser` tool failures now emit a durable host-boundary log line (wire error code + action + argument key names + agent ID + redacted session ID, never argument values or error messages; CWE-532)
- **Web** — A reload at `#/c/<sessionId>` now lands on the running chat instead of the restored terminal: ChatRoute re-delegates tab activation after the boot layout restore replaces the pane tree (gated so user tab/focus intent and closed chats are never hijacked)
- **Web** — The termul-server web launcher's chat composer now shows the worktree isolation picker for git-repo projects (same as the desktop): a successful `git/commit-context` probe stamps `isGitRepo` (the worktree reconciler is desktop-only and `ProjectSummary` carries no git fields), and the project mirror preserves the flag across `projects_changed` refetches

### Performance
- **ACP** — Bound live transcript memory for long agent chats: over-limit sessions now trim to the 300-message live window after a background durability probe confirms host-owned history (lossless; `live_only` sessions never trim)
- **ACP** — Cap live tool calls at 500 per session (oldest finished calls drop, in-flight always retained; install paths capped too) and clamp oversized string `rawOutput` to 32 KiB + truncation marker on live update
- **ACP** — Cap payload-cache pins at 8 with project-switch unpin; amortize coalesced streaming text merges to O(delta) per frame instead of per-chunk full-text copies
- **Terminal** — Coalesce PTY appends to one `appendTranscript` per terminal per frame, with a 250ms timer backstop for hidden windows and an unmount drain failure log
- **Server** — Serve the web bundle with gzip compression (`Accept-Encoding`-negotiated; #857) and pin Vite-hashed `/assets/*` with `Cache-Control: public, max-age=31536000, immutable` on the disk `ServeDir` path (the embedded path already did) — cold load drops from 3.66 MB to ~0.98 MB on the wire
- **Web** — Memoize `GET /acp/catalog` client-side: in-flight dedupe + 2s staleness window at the facade boundary (#844). Transcript-driven re-renders no longer re-fetch the catalog (~400 req/s peak during a streaming turn); explicit refresh and opt-in toggles still bypass/invalidate

### Bug Fixes
- **Web** — A timed-out `send_prompt` (socket dropped mid-turn) no longer toasts a send failure: the outcome is unknown until replay delivers `prompt_complete`, so the generic error is downgraded to a transient host log (#844)
- **ACP** — A rejected durability probe releases its slot so the next over-limit flush retries; probe bookkeeping and clamp-log dedup are cleared on session drop (no phantom pins, no pin resurrection)

## [0.4.0] - 2026-05-31

### Features
- **Git** — Read-only Git History graph view (#202)
- **Git** — Commit, amend, and push from the Git panel (#200)
- **Git** — Git panel staging, unstaging, and discard (#190)
- **Git** — Git changes tab with terminal session/crash recovery and project settings (#143)
- **SSH** — SSH & Remote Connection Manager with full SFTP support (#146)
- **UI** — Platform-adaptive title bar with VSCode-style activity rail (#194)
- **Command Palette** — Project-first ordering, pinning, and condensed layout (#193)
- **Sidebar** — Declutter project list with truncation + search (#192)
- **Terminal** — Desktop notification + highlight for finished terminal on exit (#187)
- **Terminal** — Default renderer to WebGL with DOM fallback + AppSettings toggle (#175)
- **Worktree** — Git worktree as sub project (#171)
- **Worktree** — Simplified worktree UX for non-technical users (#186)
- **Tabs** — Middle-click close for terminal and browser tabs (#176)
- **Project** — Per-project settings gear button and compact context menu (#159)
- **Linux** — UI polish + HiDPI dropdown menu fixes (closes #129) (#165)
- **Landing** — New landing page (#153) with Google Tag Manager snippet (#181)

### Bug Fixes
- **Window** — Restore window geometry in logical pixels to prevent off-screen windows (#206)
- **Sidebar** — Only expand worktrees via chevron (#203)
- **SSH** — Repair SSH connection status, DNS connect, keychain persistence, and host-key verification (#198)
- **Security** — Add browser tab IPC caller validation (#196)
- **Security** — Implement secure storage for project environment variables (#167)
- **Security** — Redact persisted project env vars (#164)
- **Updater** — Repair auto-update download/install flow with confirm-before-restart (#191)
- **Git** — Align git tab height and remove panel gap (#189)
- **Worktree** — Run git from repo dir when removing worktree (#188)
- **Worktree** — Suppress git console window flashing on Windows (#183)
- **Terminal** — Prevent grid collapse to 1-2 rows on minimize/restore (#185)
- **Terminal** — Support clipboard image paste passthrough to CLI apps (#182)
- **Terminal** — Prevent terminal spawn storm during hidden window bootstrap (#174)
- **Terminal** — Resolve terminal skew after minimize/restore (#173)
- **Terminal** — Move xterm container ref inside padding wrapper (#172)
- **Browser** — Fix element selector annotation not working inside form tags (gh-127) (#140)
- **Explorer** — Prevent search from opening console window on Windows (#157)
- **UI** — Resolve new project modal/browser layering and require root directory (#158)
- **Mermaid** — Prevent DOM leak on syntax error (#156)

### CI & Chores
- **CI** — Migrate landing Docker hosting to Cloudflare Pages (#179)
- **CI** — Add macOS Intel release target (#163)
- **CI** — Migrate package workflow to bun (#166); pin bun CI to 1.3.x and bun action to v2 (#168)
- **Build** — Bump Vite to v8 (#169); remove obsolete vite config (#170)
- **TSConfig** — Use bundler moduleResolution in tsconfig.node.json (#161)

## [0.3.8] - 2026-05-18

### Features
- **Terminal** — Ctrl/Cmd+click URLs open in internal browser, respecting default browser preference (#125)
- **Terminal** — Upgrade xterm.js to 6.1-beta; fix terminal truncation on minimize/project-switch and memory leaks (#135)
- **UI** — Pane-level fullscreen toggle with smooth animation (#141)
- **UI** — Redesigned command palette power tools (#142)
- **UI** — Shortcut reference menu for quick keyboard shortcut lookup (#145)
- **Search** — Ripgrep-powered sidecar file search with explorer resize handles and tooltip UX (#124)

### Bug Fixes
- **Shortcuts** — App shortcuts now work consistently from terminal, editor, and browser focus (#128)
- **Terminal** — Shortcut passthrough: app shortcuts fire correctly from terminal focus (#138)
- **Editor** — Fix visibility hidden for editor panels + window permissions (#116)

### CI & Chores
- **GitHub** — Add community templates & CI security hardening (#144)

### Documentation
- Professionalize README with extended feature list and star tracking (#136, #137)
- Add project context documentation and docs index updates (#132)

## [0.3.6] - 2026-05-08

### Features
- **Browser** — Built-in browser tab foundation (#112)
- **Browser** — Web annotation tool for marking and annotating web pages (#113)
- **Terminal** — Open file paths on Ctrl/Cmd+click in terminal output (#110)
- **UI** — Close button added to AppPreferences and ProjectSettings headers (#118)

### Bug Fixes
- **macOS** — Platform-aware keyboard shortcuts, native traffic lights & error resilience (#114)
- **Mermaid** — Fix text invisible due to DOMPurify stripping style & foreignObject (#119)
- **Terminal** — Terminal stability improvements (#109)
- **Signing** — Update ed25519 public key for new key pair

## [0.3.4] - 2026-05-01

### Features
- **AUR** — Add Arch Linux (AUR) update support (#89)
- **Editor** — Add mermaid chart viewer to markdown editor
- **Editor** — Interactive mermaid charts with zoom, pan, and drag
- **Terminal** — Remember close confirmation preference and show tab close loading state

### Bug Fixes
- **Terminal** — Fix padding gap blending and container color cohesion
- **Terminal** — Remove artificial 300ms timeout on terminal kill
- **Editor** — Fix TOC active indicator not updating on click
- **Editor** — Scroll heading to top instead of center on TOC click
- **Editor** — Add smooth scroll to BlockNote TOC heading navigation
- **Editor** — Capture wheel events natively to prevent page scroll; fix zoom blur on mermaid charts
- **MermaidBlock** — Remove DOMPurify to preserve mermaid SVG styles
- **MermaidBlock** — Fix mermaid.initialize to preserve inline styles
- **MermaidBlock** — Use ref callback for wheel listener so zoom works after BlockNote re-mounts
- **Explorer** — Fix delete not working for folders and nested files
- **Editor** — Fix editor store operation status, close guards, XSS sanitization
- **Editor** — Fix pasting, deletion, rename error handling, tab status, and test leaks
- **Updater** — Recover from missing latest.json and harden CI pipeline
- **Security** — Replace env var pubkey with hardcoded ed25519 public key

### Styling
- Compact sidebar projects layout & remove bold text
- Compact tabbar layout
- Add split pane border via ResizableHandle bg-border
