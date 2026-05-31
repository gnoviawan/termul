# Changelog

All notable changes to this project will be documented in this file.

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
