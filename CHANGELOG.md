# Changelog

All notable changes to this project will be documented in this file.

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
