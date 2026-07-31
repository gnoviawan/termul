---
project_name: 'termul'
user_name: 'Althio'
date: '2026-07-19'
sections_completed:
  [
    'technology_stack',
    'language_rules',
    'framework_rules',
    'remote_parity',
    'ui_responsive_mobile',
    'testing_rules',
    'quality_rules',
    'workflow_rules',
    'codebase_discovery_logging',
    'anti_patterns',
  ]
status: 'complete'
rule_count: 76
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss. Logging is mandatory when adding a feature; ADRs are recommended (not mandatory). For the dual-target (desktop ↔ termul-server) architecture and responsive web/mobile UI, see the Remote Parity and UI/Responsive sections._

---

## Technology Stack & Versions

- **Desktop runtime:** Tauri 2 — `@tauri-apps/api` `2.11.0`, `@tauri-apps/cli` `^2`; Rust `tauri = "2.0"` (features `unstable`, `devtools`, `tray-icon`). Two binaries in one crate `termul_manager_lib` (see Remote Parity).
- **Backend:** Rust, **MSRV 1.85**, edition `2021` (ACP 0.12 vendored → edition 2024 requires ≥1.85).
- **Frontend:** React `18.3.1` + React DOM `18.3.1`; two renderer entries — `TauriApp.tsx` (desktop) and `App.tsx` (web).
- **Language/tooling:** TypeScript `^7.0.2`, **strict** (`strict`, `noImplicitAny`, `isolatedModules`, `moduleResolution: bundler`, `jsx: react-jsx`, `noEmit`). ESM-first (`"type": "module"`).
- **Build/test:** Vite `^8.0.14` (rolldown), Vitest `^4.1.6` with `jsdom ^27.4.0`, `@vitejs/plugin-react-swc`. Package manager **Bun** (`bun@1.3.1`).
- **Linting/formatting:** **Biome `2.4.16`** — NOT ESLint. `bun run lint|check|format|ci`. (Only `landing/` ships an eslint config; the main app does not.)
- **UI/state:** Tailwind CSS **v4** (`@tailwindcss/postcss ^4`, `@tailwindcss/typography`), Zustand `^5.0.9`, TanStack React Query `^5.83.0`, TanStack React Virtual `^3.14.9`, Radix UI + shadcn (`shadcn ^4.12.0` dev), `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `framer-motion ^12.25.0`.
- **Routing:** React Router DOM `^6.30.1` using **hash-router** patterns (both entries).
- **Terminal stack:** `@xterm/xterm ^6.1.0-beta.216` (+ addon-fit/search/serialize/web-links/webgl beta), `tauri-pty ^0.1`; Rust `portable-pty 0.9`.
- **Forms/validation:** React Hook Form `^7.61.1`, `@hookform/resolvers ^3.10.0`, Zod `^3.25.76`.
- **ACP / AI:** `agent-client-protocol 0.12` (vendored 0.12.1 at `src-tauri/vendor/`), `tauri-plugin-mcp-bridge 0.9`, `ai ^7.0.4`, BlockNote `^0.46.2`, CodeMirror 6, streamdown `2.5.0`, mermaid `^11.14.0`.
- **Remote server stack (Rust):** Axum `0.8` (ws), `tower-http 0.6` (cors/fs/trace), `rust-embed 8.12` (embeds `dist-web/`), `reqwest 0.13` (rustls), `tokio 1` (full), `parking_lot 0.12`, `keyring 3.6` (OS-native per target), `ssh2 0.9`.
- **Logging:** `tauri-plugin-log 2` + `log 0.4` (desktop runtime) and `tracing 0.1` + `tracing-subscriber 0.3` (standalone server); `src-tauri/src/logging.rs` owns desktop setup, `server_main.rs` uses tracing. Renderer facade: `src/renderer/lib/log-api.ts`.
- **Shell tests:** `bats ^1.13.0` (`bun run test:shell`); hooks via `husky ^9.1.7`.

### Critical stack constraints for AI agents

- Treat this repo as a **Tauri-first desktop app with a built-in web/remote server** — not a generic browser SPA, and not Electron.
- `docs/electron-old/` and `_bmad-output/planning-artifacts/architecture.md` (the "pecutan" Electron design) are **archival** — do not treat them as active guidance.
- Keep native/runtime integration behind `src/renderer/lib/tauri-*.ts` facades. This is **machine-enforced** by Biome (see Code Quality).
- `src/shared/` is for shared contracts/types only; runtime-neutral. `src/renderer/` owns UI; `src-tauri/` owns OS/process/backend.
- **Two Vite configs**: `vite.config.tauri.ts` (desktop) and `vite.config.web.ts` (web client, aliases `@tauri-apps/*` → stubs, sets `import.meta.env.TERMUL_WEB`). Don't assume one config.
- Use scoped `@xterm/*` packages, never legacy `xterm`.
- Keep renderer code test-friendly under `Vitest + jsdom`; keep native concerns behind adapter seams.

## Critical Implementation Rules

### Language-Specific Rules

- TypeScript is **strict-by-default** (`strict`, `noImplicitAny`). Prefer explicit types for public APIs, store state, params, and return values when inference isn't obvious.
- ESM-first (`"type": "module"`). Do not introduce CommonJS config/import patterns unless a file already requires it.
- **Aliases differ per config** — verify before relying on one:
  - root `tsconfig.json` (project-references aggregator) defines only `@/*` → `./src/renderer/*`.
  - `tsconfig.web.json` defines `@renderer/*`, `@/*`, `@shared/*` → `./src/renderer|shared/*`.
  - `tsconfig.test.json` + `vitest.config.ts` add `@material-icons/` and `@/types`.
  - `vite.config.web.ts` / `vite.config.tauri.ts` add `@/`, `@renderer/`, `@shared/`, `@material-icons/` (web also adds Tauri stub aliases).
  - Prefer `@renderer/*` and `@shared/*` in new code; avoid deep relative paths.
- Use async/await for async flows. Don't silence type/runtime issues with blanket `any`, unsafe casts, or catch-all suppressions. (Note: Biome's `noExplicitAny`/`noNonNullAssertion` are OFF, so these aren't lint-blocked — discipline is manual.)
- Keep browser-safe and native-aware code separated: generic renderer code depends on facades/contracts; Tauri/native access stays in `src/renderer/lib/tauri-*.ts` or clearly Tauri-scoped files.

### Framework-Specific Rules

- Treat the React app as a **desktop-oriented Tauri renderer that also runs as a web client**. Two entries: `TauriApp.tsx` (desktop: window state, crash recovery, remote projects, notifications, native menus) and `App.tsx` (web: `isTauriContext()` gating, Alt-menu prevention). Both share hash-router + the same pages/layouts/stores.
- Preserve the separation: UI/components/pages in `src/renderer/`, shared contracts in `src/shared/`, native/backend in `src-tauri/`.
- Reuse existing adapter/facade modules in `src/renderer/lib/` (`tauri-filesystem-api`, `git-api`, `shell-api`, `tauri-dialog-api`, `tauri-runtime`, `web-server-api`) before adding direct Tauri/plugin calls inside components.
- Reuse existing Zustand stores in `src/renderer/stores/` before new global-state mechanisms; use selector access to limit rerenders.
- TanStack React Query is an async/cache layer, not a replacement for Zustand app/session/UI state.
- Preserve **hash-router** navigation; do not switch to browser-history routing.
- Follow feature-folder component organization; prefer existing Radix/shadcn + Tailwind patterns over a second UI system.
- When adding behavior exposed to UI, gate native-only paths with `isTauriContext()` (from `@/lib/tauri-runtime`) and provide a web-mode fallback (see Remote Parity).

### Remote / Multi-Target Parity Rules  *(desktop ↔ termul-server)*

This project ships a **shared-live dual-target architecture**. The desktop app and the standalone `termul-server` share code — changes to one side MUST be checked against the other.

- **Two binaries, one crate** (`termul_manager_lib`): desktop `src-tauri/src/main.rs` (`termul-manager`, `default-run`) and standalone `src-tauri/src/server_main.rs` (`termul-server`, feature `standalone-server`, path **outside** `src/bin/` so the Tauri bundler doesn't re-add it). The standalone is a **console** subsystem (no `windows_subsystem = "windows"`).
- **Shared `web` module** (`src-tauri/src/web/`: `router.rs`, `ws.rs`, `fs_api.rs`, `project_registry.rs`, `projects_api.rs`, `config.rs`, `permissions.rs`, `chat_history_cache.rs`, `assets.rs`, `sink.rs`) is consumed by BOTH:
  - Desktop in-process via `web::serve_router` (driven by `remote/host.rs` `RemoteServerState`) — **never kills agents**.
  - Standalone via `web::serve` (in `server_main.rs`) — **calls `AcpManager::kill_all` after Axum drains**.
  - ⚠️ **Kill-all hazard:** the desktop shared-live path MUST use `serve_router` (never `serve`). Stopping the shared-live server must NOT kill the desktop's live agents.
- **Shared `dist-web` bundle** is built by `vite.config.web.ts` (entry `App.tsx`, `TERMUL_WEB` gate, `@tauri-apps/*` → stubs) and embedded into the binary via `rust-embed`. `tauri.conf.json` `beforeBuildCommand` builds `dist-web` **then** `dist-tauri`. Served by BOTH the desktop in-process server and the standalone server.
- **Shared `IpcResult<T>` contract** (`src-tauri/src/commands.rs`, `IpcResult.success/error`) is the body shape for **both Tauri commands and web routes** (`web/fs_api.rs` `IpcBody<T>`). Renderer facades return the same shape; transport failures map to `{ success: false, code: 'NETWORK_ERROR' }`. Changing any command/result/route shape MUST update all three: the Tauri command, the `web/*` route, and the renderer facade.
- **Shared `AcpManager` + `WsRelaySink` + `PermissionRendezvous`**: desktop resolves permissions via the `acp_respond_permission` Tauri command directly; standalone uses `/ws respond_permission` + the rendezvous (first-response-wins, disconnect-deny, TOCTOU-safe). Permission-flow changes must update both paths.
- **Renderer facade parity** (`src/renderer/lib/web-server-api.ts` + `tauri-runtime.ts`): when `!isTauriContext()`, facades swap to HTTP impls hitting `web/router.rs` routes. A new Tauri command exposed to UI must get an **equivalent web route + facade**, or be explicitly desktop-only-gated. Do not ship a Tauri command that breaks web parity without an ADR-acknowledged reason.
- **Remote exposure**: `src-tauri/src/remote/host.rs` (in-process shared-live, `RemoteBindMode::Localhost|All`) + `remote/cloudflared.rs` (tunnel). `remote_server_start/stop/status` are Tauri commands. LAN exposure is an explicit operator decision; auth/token-gating is not yet complete — don't assume it.
- **Mandatory parity check:** whenever you change desktop runtime/command/IPC/event/contract behavior, open the matching `src-tauri/src/web/` route, `server_main.rs` path, and renderer facade, and update all sides. Add a regression test for both desktop and web paths where feasible.

### UI / Responsive & Mobile Rules

"Mobile" here means the **responsive web client served by `termul-server`** (phone browsers over LAN/tunnel) — there is **no native mobile target** (`gen/android` and `gen/ios` are not scaffolded; only `icons/android|ios` branding exists). Build UI to work in a browser/phone, not just the Tauri webview.

- New UI must be **responsive and mobile-friendly**: prefer `react-resizable-panels`, `react-virtuoso`/`@tanstack/react-virtual` for long lists, and existing responsive patterns (`components/chat/chat-responsive`, `chat-layout.ts`, `ProjectSwitcherDrawer`). Don't hardcode desktop-only dimensions.
- **Feature-detect native surfaces** (window controls, tray, native notifications, OS dialogs). Desktop entry `TauriApp.tsx` has them; web `App.tsx` does not. Gate with `isTauriContext()` and degrade gracefully.
- Keep the bundle **web-safe**: no direct `@tauri-apps/*` imports in components/hooks/stores (Biome-enforced). Route native calls through `src/renderer/lib/` facades that have web-mode fallbacks.
- Don't assume native chrome, drag-drop, or global hotkeys exist on the web/mobile surface — provide keyboard + touch equivalents.
- When designing a feature, ask: "Does this work on a phone browser served by termul-server?" If not, gate it desktop-only with an explicit `isTauriContext()` branch and document why.

### Testing Rules

- Colocate tests with code: `*.test.ts` / `*.test.tsx` next to the file (excluded from `tsconfig.web.json`). Vitest globs `src/**/*.test.{ts,tsx}` + `scripts/**/*.test.ts`.
- Renderer tests run under `Vitest + jsdom`; do not assume a real Tauri runtime in unit/component tests. Typecheck tests via `tsconfig.test.json` (`bun run typecheck:test`).
- Test through public behavior and exported interfaces, not internals. Keep native/runtime code behind adapter seams so it mocks cleanly.
- For Tauri-facing behavior, test the renderer-side contract and the mocking boundary (facade), not native execution.
- For web/server behavior, test the `web/*` route + the `IpcResult` contract through `web-server-api.ts` (or a `tower` test harness for Axum — see `dev-dependencies` `tower 0.5`).
- Add regression tests for bug fixes, especially terminal/session/workspace, ACP/permission flow, and desktop↔server parity boundaries.
- Rust tests: `cd src-tauri && cargo test` (the `tauri = { features = ["test"] }` dev-dep enables app-handle test helpers). Shell tests: `bun run test:shell` (bats).

### Code Quality & Style Rules

- **Linting/formatting is Biome, not ESLint.** Run `bun run lint` (lint), `bun run check` (lint+format+import-sort), `bun run format` (write), `bun run ci` (strict CI mode, errors only). Don't add ESLint/Prettier configs to the main app.
- Biome formatter: **2-space indent, lineWidth 100, no semicolons (`asNeeded`), single quotes, no trailing commas.** `assist.organizeImports` is ON — imports are auto-sorted; don't hand-order.
- **Machine-enforced facade boundary:** `style.noRestrictedImports` = **ERROR** bans `@tauri-apps` + `@tauri-apps/**` everywhere **except** `src/renderer/lib/**` (override OFF) and `*.test|*.spec|vitest.setup.ts` (override OFF). Importing Tauri APIs outside `lib/` is a hard CI failure.
- a11y rules are **warn** (`useButtonType`, `noLabelWithoutControl`, `noStaticElementInteractions`, `useKeyWithClickEvents`, etc.) — fix them in non-test code.
- Match existing naming patterns in the surrounding folder. Reuse existing helpers/primitives before near-duplicates. Use Tailwind tokens/CSS variables over hardcoded values.
- Comments lean: add for intent or non-obvious constraints, not to narrate obvious code. Favor clear types and readable contracts over clever compactness for public/shared APIs and adapter seams.
- Keep changes compatible with the validation flow: `bun run lint`, `bun run typecheck`, `bun run test` must stay green.

### Development Workflow Rules

- **Validation before "done":** `bun run lint`, `bun run typecheck` (`node`+`web`+`test`), `bun run test` (Vitest); Rust: `cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test`. `bun run ci` is the strict CI gate.
- **PR gate (mandatory):** all CI checks green (PR Validation: lint/typecheck/test/Rust/Windows smoke; Build Verification; Security: CodeQL/secret-scan/dep-review/Scorecard) **AND** CodeRabbit review resolved before merge. See `CLAUDE.md`. Never force-push to retrigger CI without fixing the root cause.
- Integration branch is **`dev`** (per the indexed graph). PRs target `dev`.
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. One problem per PR — no bundled unrelated changes, no style-only PRs without substance.
- Prefer incremental changes that fit existing structure over large unsolicited rewrites. If touching cross-boundary behavior, preserve consistency across `src/renderer/`, `src/shared/`, and `src-tauri/` (including `src-tauri/src/web/`).
- Update/add tests before treating work as done. Update `docs/` when a change alters user-facing behavior, setup, or architecture guidance.

### Codebase Discovery & Logging Rules

- **Use the codebase-memory MCP knowledge graph for code discovery**, not grep/glob for code. Discover the local project key dynamically with `list_projects` / `index_status` — it is derived from the repo path and differs per machine/contributor, so never hardcode it. Priority order:
  1. `search_graph` — find functions/classes/routes/variables (BM25 + name regex + semantic).
  2. `trace_path` — callers/callees, data flow, cross-service hops.
  3. `get_code_snippet` — read a symbol's source by `qualified_name`.
  4. `query_graph` — Cypher for multi-hop patterns; use complexity props (`cyclomatic`, `transitive_loop_depth`, `linear_scan_in_loop`) to find hot paths.
  5. `get_architecture` — packages, clusters, entry points, hotspots, boundaries.
  - Fall back to `grep`/`find` for string literals, error messages, config values, and non-code files (Dockerfiles, shell, configs).
  - Confirm the graph project/generation with `list_projects`/`index_status` at session start or after compaction; state coverage limits when making exhaustive/negative claims.
- **Logging is mandatory when adding a feature or flow** — it is the primary maintainability/debuggability surface (issue #244). The stack differs per target; use the right one:
  - **Desktop Rust runtime**: emit via the `log` facade (`log::info!`/`warn!`/`error!`/`debug!`). Routed by `tauri-plugin-log` (`src-tauri/src/logging.rs`) to `<app_log_dir>/termul.log` (rotated, KeepOne, 5MB) + stdout in debug. Levels via `RUST_LOG` (floor `info` release / `debug` debug; per-module overrides supported). A global panic hook and per-process `session_id()` (8-char) already exist — reuse `session_id()` for correlation-worthy lines.
  - **Standalone `termul-server`**: uses `tracing` + `tracing-subscriber` (`EnvFilter`, `RUST_LOG`) initialized in `server_main.rs`. Use `tracing::info!`/`warn!`/`error!` (NOT the `log` facade) on this path.
  - **Renderer**: import from `src/renderer/lib/log-api.ts` (`logFrontendError`, `installGlobalErrorForwarding`), which forwards to the backend log via the `log_frontend_error` Tauri command and never throws. Prefer it over raw `console.*` for errors/warnings that must survive a closed DevTools. (This facade is desktop-only; the web client has no error-forwarding to the backend yet — a parity gap to be aware of, not a reason to sprinkle `console.log`.)
  - **What to log**: meaningful boundaries — operation start, success, and especially failure (with context: ids, paths, offending input/error). Errors must be logged, never swallowed silently. Levels: `info` normal ops, `warn` recoverable degradation, `error` failures, `debug`/`trace` dev-only detail. Never log secrets/credentials (keyring values, tokens, env contents).
  - Reuse existing helpers for new runtime entrypoints: `logging::log_startup_banner`, `logging::install_panic_hook`, `logging::session_id`, `logging::log_file_path`.
- **ADRs (recommended, not mandatory):** for significant architectural decisions, record an ADR in `docs/adr/` using the `Status / Date / Author / Context / Background / Architecture / Consequences` format, and register it in `docs/adr/README.md`. The current tree contains reconstructed ACP references for ADR-003/004; ADR-001/002 and any unavailable historical originals remain unresolved. The `manage_adr` MCP tool can create/update them. Validate against the live codebase (see the reconstructed ADR-003 "Validation note" pattern).

### Critical Don't-Miss Rules

- Do **not** treat archived Electron migration material (`docs/electron-old/`, `_bmad-output/planning-artifacts/architecture.md`) as active guidance.
- Do **not** bypass `src/renderer/lib/` adapter boundaries — Biome will fail the build on direct `@tauri-apps/**` imports outside `lib/` and tests.
- Do **not** put renderer-specific UI logic or Tauri runtime behavior into `src/shared/`; keep it contract-focused and runtime-neutral.
- Do **not** assume alias behavior is identical across `tsconfig.json` (root, only `@/*`), `tsconfig.web.json` (all three), and Vite/Vitest configs.
- Do **not** assume one Vite config — `vite.config.web.ts` and `vite.config.tauri.ts` differ; Tauri stub aliases are web-only.
- Do **not** treat the app as browser-history-first — preserve hash-router.
- Do **not** introduce a second state/UI framework when Zustand, Tailwind, Radix/shadcn already cover it.
- Do **not** "fix" strict typing with blanket `any`, unsafe casts, or suppressions.
- Do **not** ship a desktop-only Tauri command/behavior without checking the `termul-server` + `web/*` route + renderer facade parity.
- Do **not** use `web::serve` on the desktop shared-live path — use `serve_router` (kill-all hazard).
- Do **not** build UI that only works in the Tauri webview — verify it degrades for web/mobile via `isTauriContext()` facades.
- Do **not** ship a feature or flow without structured logs at its boundaries (start/success/failure).
- Do **not** swallow errors silently — log them with context (ids, paths, offending input).
- Do **not** use raw `console.*` in the renderer for errors that must survive a closed DevTools — use `src/renderer/lib/log-api.ts`.
- Do **not** log secrets/credentials (keyring values, tokens, env contents).
- (ADRs are recommended, not mandatory, for significant architectural changes — `docs/adr/`.)
- Watch for regressions in terminal/session/workspace, ACP/permission, and desktop↔server parity whenever touching cross-boundary desktop functionality.

---

## Usage Guidelines

### Preflight Checklist

1. Read this file before implementing any code.
2. Decide whether the change belongs in `src/renderer/`, `src/shared/`, or `src-tauri/` (and if `src-tauri/`, whether it affects the shared `web/` module or `server_main.rs`).
3. Respect the Tauri-first + shared-live architecture; do not reintroduce Electron-era patterns.
4. Use the codebase-memory MCP graph (`search_graph` → `trace_path` → `get_code_snippet`) to understand existing code before writing.
5. Keep native/plugin access behind `src/renderer/lib/tauri-*.ts` facades (Biome-enforced); add web-mode fallbacks for new facades.
6. Check desktop↔`termul-server` parity: update the Tauri command, the `web/*` route, and the renderer facade together; mind the kill-all split (`serve_router` vs `serve`).
7. Make UI responsive/mobile-friendly and `isTauriContext()`-gated; don't assume native chrome.
8. Follow strict TypeScript + Biome rules (no semicolons, single quotes, no trailing commas, 2-space, lineWidth 100).
9. Add colocated `*.test.ts` / `*.test.tsx` (Vitest + jsdom); for server changes, test the route + `IpcResult` contract.
10. Add structured logs for any new feature/flow — Rust desktop via the `log` facade, `termul-server` via `tracing`, renderer via `src/renderer/lib/log-api.ts` (not raw `console.*`). Log failures with context; never swallow errors silently. (ADRs recommended for significant architectural changes — `docs/adr/`.)
11. Run `bun run lint`, `bun run typecheck`, `bun run test`, and `cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test` before considering the change complete.

**For AI Agents:**

- Read this file before implementing any code. Follow all rules exactly as documented.
- Prefer the more restrictive option when in doubt.
- Use the codebase-memory MCP graph for discovery; update this file if new patterns emerge.

**For Humans:**

- Keep this file lean and focused on agent needs. Update when the stack or architecture changes.
- Review quarterly for outdated rules. Remove rules that become obvious over time.
- Re-index the codebase-memory MCP graph when structure changes materially; discover the project key via `list_projects` / `index_status` (it is machine-specific).

Last Updated: 2026-07-19
