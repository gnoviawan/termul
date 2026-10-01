# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.4.18] - 2026-10-02

### Highlights
- **Switch agents mid-chat.** Pick a different agent from the composer and keep going: the live transcript and a handoff summary carry over, the timeline marks the switch, and the sidebar shows which chats used more than one agent.
- **Inline AI assist in the terminal.** Explain a command's output or fix a failing command right from the terminal.
- **Idle notifications.** Get notified when a long-running terminal tab goes quiet.
- **Per-line staging.** Stage or unstage individual lines inside a git hunk.
- **Installable web client.** The termul-server web client is now a PWA, works on phones, and shows connection health with safer offline input.
- **Headless agent sign-in.** Agents that need OAuth can sign in from a terminal, with a paste-back flow for remote and headless setups.
- **Faster with many projects.** Rendering only works on the visible workspace, transcript memory is bounded, and startup no longer rescans every session file.
- **Fresh look.** A new semantic color system across the app, plus smoother scrolling and transitions.
- **Signed macOS builds.** The macOS DMG is now notarized and stapled.
- **Linux CPU fix.** The ACP agent process no longer pins a CPU core at 100% on Linux (#717).

See the [v0.4.18 release](https://github.com/gnoviawan/termul/releases/tag/v0.4.18) for screenshots and install notes.

### Features
- **ACP** — Switch agents mid-chat from the composer chip row: live transcript and a handoff summary carry over, the timeline marks the switch, and the sidebar flags multi-agent chats (#737, #739, #744, #748, #753, #760, #764, #766, #775)
- **ACP** — Headless OAuth: terminal auth methods plus a browser-open shim with paste-back (#715)
- **ACP** — Replace CI-enforced registry CDN sync with an in-app runtime registry update (#711)
- **Terminal** — Inline AI assist to explain output or fix a failing command (#689)
- **Terminal** — Notify when a long-running tab goes idle (#682)
- **Git** — Per-line stage/unstage within a hunk (#681)
- **Web** — Installable PWA web client, connection health surface, and offline input safety (#705, #731)
- **Agents** — Stream git worktree-add progress into the chat as a collapsible first-response row (#752, #762)
- **MCP** — Auto-probe enabled MCP servers on app boot (#738)
- **Project** — Auto-derive project name from the folder; advanced options move to a collapsible section (#686)
- **Workspace** — Unified tab-bar context menus and middle-click close across all tab kinds (#747)
- **Chat** — Agent chat UI/UX polish and ACP workflow improvements (#726)
- **UI** — OKLCH semantic token foundation adopted across chat, workspace, terminal, panels, and dialogs (#767, #769, #770, #771, #772)
- **UI** — Smooth inertial wheel scrolling; polished sidebar, explorer, pane drag-and-drop, and agent-launcher-to-composer transitions (#743, #749, #761, #763)

### Performance
- **ACP** — Trust persisted metadata on startup instead of rescanning every session JSONL (#721)
- **ACP** — Bound live transcript memory (300-message live window after a durability probe), cap live tool calls at 500 per session, clamp oversized `rawOutput` to 32 KiB, and cap payload-cache pins at 8 (#735)
- **Terminal** — Coalesce PTY appends to one `appendTranscript` per terminal per frame (#735)
- **Renderer** — Scope streaming render work and tab activation to the visible workspace; remove the commit storm, quadratic diff, and hidden-tab render churn (#728, #773)

### Bug Fixes
- **ACP** — Fix a 100% CPU busy loop in the ACP agent process on Linux by forcing the SIGCHLD reaper for repo-root Cargo builds (#776, #779; fixes #717)
- **ACP** — Reuse provider auth instead of re-login on worktree/project launch (#729)
- **ACP** — Resumed chats keep full scroll-back and skill chips, never persist replayed history, and no longer duplicate messages or the first prompt on scroll-up (#698, #733, #736, #740, #751)
- **ACP** — Accept Claude Desktop object-map headers in MCP JSON import and log remaining rejection branches (#691, #693)
- **ACP** — Composer option fidelity for launch and armed agent switch; first-wins dedupe for promoted model/thought-level options and slash-menu skills (#712, #741, #764)
- **ACP** — Ephemeral warm pool with no synthetic prompts; logging hygiene and redaction in acp-store; removed the "Starting agent" banner (#703, #720, #722)
- **Worktree** — Drop the invalid `--progress` flag that broke every isolated agent launch (#754)
- **Chat** — Render file paths, markdown images, and command pills correctly; require path evidence before linkifying (#723, #724, #727)
- **Renderer** — Failed-session lifecycle with working retry and no dead tabs; multi-method agent auth progression; replay dedup on reconnect; chat history loads after the WS handshake; chat panel stays mounted across session remap (#699, #700, #701, #706, #765)
- **Renderer** — Responsive phone layout below 767px and mobile UX remediation (#707, #714); explorer and center-dropped tab fixes (#750)
- **Server** — Fail-closed web auth token gate for public binds (#696)
- **Server** — Persist the project registry across restarts by default (#697)
- **Server** — Resolve login `PATH` under systemd for agent spawns (#687)
- **Server** — Protocol hygiene, agent auth error codes, git route guards, branch ops, and shell fallback (#702, #704, #710, #716)
- **Remote** — Keep cloudflared pipes drained after the tunnel URL is found (#713)
- **Desktop** — Re-grant fs scope for restored project roots after restart (#685)
- **Desktop** — Default new terminal and ACP session cwd to the main project root (#688)
- **SSH** — SSH profile delete context menu and unified hover reveal (#692)
- **Agents** — Preserve Factory Droid update state (#732)
- **Security** — Main webview navigation allow-list (#680)
- **UI** — Restore the custom app-wide scrollbar (#734)

### Build & Release
- **macOS** — DMG is now notarized and stapled in the release workflow; first release with verified macOS signing (#781)
- **CI** — Fix Rust 1.99 clippy/deprecation failures on stable CI (#780)

### Contributors
Thanks to @davidgrldo, @julianromli, and @kuravista, and to @insankhamil for the #717 report.

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
