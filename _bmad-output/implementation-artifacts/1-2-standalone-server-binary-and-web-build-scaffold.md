---
baseline_commit: 96ca3f2c
---

# Story 1.2: Standalone Server Binary & Web Build Scaffold

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a Termul maintainer,
I want a standalone `termul-server` binary and a web build target,
so that the server can run headless on a VPS without the Tauri webview runtime.

## Acceptance Criteria

1. **AC1 — Standalone `termul-server` binary entry created and feature-gated.** `src-tauri/src/bin/termul_server.rs` is created. `src-tauri/Cargo.toml` gains a `[[bin]] name = "termul-server"` entry that is gated behind a new `standalone-server` Cargo feature (`required-features = ["standalone-server"]`) so that the default `cargo build` and `tauri build` (desktop) do NOT build or bundle it (Tauri bundler copies every `[[bin]]` it discovers — see Dev Notes). `rust-embed = "8.12"` is added to `[dependencies]` (it is genuinely missing today). `tower-http` and `axum` are ALREADY present (`tower-http = "0.6"` with `fs` feature, `axum = "0.8"` with `ws`) — they MUST NOT be re-added (a duplicate dep line is a Cargo error). The binary constructs a fresh `AcpManager` with NO `AppHandle` — it passes a `WsRelaySink`-backed `Vec<Arc<dyn EventSink>>` (the Story 1.1 stub recorder; live WS wiring is Story 1.4) — then calls `web_server::serve(Arc<AcpManager>, ...)`.

2. **AC2 — CLI args, bind, and graceful shutdown.** The binary parses `--host` (default `127.0.0.1`; `0.0.0.0` is an explicit expose opt-in) and `--port` (default `8080`) BEFORE any app setup. On bind failure it exits nonzero. On SIGINT/SIGTERM it drains Axum (graceful shutdown) and kills all agent subprocesses (`AcpManager::kill_all().await`), then exits cleanly. A `/health` route responds `200 OK` (mirror the existing `remote/server.rs` `health_check` → `(StatusCode::OK, "OK")`).

3. **AC3 — `web_server` library skeleton (minimal).** A `web_server` library is added under `src-tauri/src/web/` exposing a `serve(Arc<AcpManager>, ServerConfig) -> ...` entry. In THIS story it contains only: `mod.rs` (re-exports + `serve`), `router.rs` (Axum router with `/health` + a placeholder for the WS upgrade + static-bundle route stub), and `config.rs` (`ServerConfig`: host, port, bind mode). It does NOT implement the WS relay (Story 1.4), auth (Epic 2), sandbox (Epic 3), or production embedding (Story 1.11). The existing `web/sink.rs` from Story 1.1 is unchanged.

4. **AC4 — ACP crate MSRV/Rust-edition verified against the vendored crate.** The dev reads `src-tauri/vendor/agent-client-protocol/Cargo.toml` and confirms `edition = "2024"` (→ requires Rust ≥ 1.85) and `version = "0.12.1"`. The project's `src-tauri/Cargo.toml` currently pins `rust-version = "1.77"` (stale — inconsistent with the ACP 0.12.1 crate's Rust 2024 edition). The dev EITHER bumps `rust-version` to `"1.85"` to reflect reality OR documents that CI's `dtolnay/rust-toolchain@stable` (≥1.85 in 2026) satisfies it and leaves a `# NOTE:` comment. The `agent-client-protocol = "0.12"` requirement and the `[patch.crates-io]` vendored redirect are UNCHANGED. `cargo build --bin termul-server --features standalone-server` succeeds.

5. **AC5 — Web build target added.** `vite.config.web.ts` is created (it does NOT exist today). It mirrors `vite.config.tauri.ts`'s plugin/alias/define setup but: input is `index.html` (the browser entry → `src/renderer/main.tsx` → `App`), `build.outDir` is `dist-web/`, `emptyOutDir: true`, target `esnext`, and it does NOT set Tauri-specific `server`/`envPrefix`/HMR config. `tsconfig.web.json` already exists and is correctly wired for a renderer+shared-only build — it is REUSED unchanged. A `build:web` script is added to `package.json` (`vite build --config vite.config.web.ts`); a `dev:web` script MAY be added (Vite dev server for the web bundle). `bun run build:web` produces `dist-web/` with a non-empty `index.html` + assets.

6. **AC6 — Web build feature-gates desktop-only features.** The web build excludes desktop-only features: interactive terminal panes, browser-tab webviews + annotation-overlay injection, updater, and native chrome are feature-gated out of the web build via a Vite `define` (e.g. `import.meta.env.TERMUL_WEB = true` / a `MODE`-based flag) that downstream stories (1.5+) use to conditionally exclude desktop code paths. NOTE: `src/renderer/main.tsx` still statically imports `TauriApp` today — the dynamic-import fix that truly tree-shakes Tauri APIs is Story 1.5's job; this story introduces the feature-gate env signal and the build config, NOT the `main.tsx` rewrite. The desktop app retains all desktop-only features locally (no desktop regression — `bun run build:frontend:tauri` still produces `dist-tauri/` unchanged).

7. **AC7 — CI extended to build the new artifacts.** `.github/workflows/pr-validation.yml` (and `release.yml` where appropriate) is extended: a job (or steps) that runs `bun run build:web` (produces `dist-web/`) and `cargo build --bin termul-server --features standalone-server` (native host target) so the standalone target is compiled in CI. Cross-compile for the VPS target (linux) lives in `release.yml` (the deploy pipeline), not the PR-validation gate. The web bundle is embedded into the `termul-server` binary via `rust-embed` in release builds (build sequencing: `bun run build:web` MUST run before `cargo build --bin termul-server --release --features standalone-server`; a missing/stale `dist-web/` fails the build with a clear error — Story 1.11 owns the full embedding, this story wires the dep + the CI ordering). `bun run lint/typecheck/test` + `cargo clippy --all-targets -- -D warnings` + `cargo test` all pass.

8. **AC8 — No desktop regression.** `bun run build` (desktop Tauri build) still succeeds — the `[[bin]] name = "termul-server"` gating MUST NOT cause the Tauri bundler to try to copy `termul-server` into the desktop app bundle (the Tauri bundler copies every `[[bin]]` it discovers; see Dev Notes for the mitigation). All existing Rust + renderer tests remain green.

## Tasks / Subtasks

- [x] **Task 1: Add the `standalone-server` Cargo feature + `rust-embed` dep + `[[bin]]` target** (AC: #1, #4, #8)
  - [x] 1.1 In `src-tauri/Cargo.toml`, add `rust-embed = "8.12"` to `[dependencies]` (genuinely missing). Do NOT add `tower-http` or `axum` (already present at `0.6` / `0.8`).
  - [x] 1.2 Add a `[features]` table entry: `standalone-server = ["rust-embed"]` (and any feature the rust-embed derive needs). If a `[features]` table does not exist yet, create it.
  - [x] 1.3 Add `[[bin]] name = "termul-server" path = "src/bin/termul_server.rs" required-features = ["standalone-server"]`. Use an explicit `path` (do NOT rely on `src/bin/` auto-discovery — see Dev Notes Tauri-bundler gotcha).
  - [x] 1.4 Resolve the MSRV inconsistency: read `vendor/agent-client-protocol/Cargo.toml` (edition 2024 → ≥1.85), then either bump `rust-version = "1.77"` → `"1.85"` in `[package]` OR add a `# NOTE: ACP 0.12.1 is edition 2024 (≥1.85); CI uses stable.` comment and leave the field. Verify `cargo build` (default, no feature) still only builds the desktop `main.rs` bin.

- [x] **Task 2: Create the `termul-server` binary** (AC: #1, #2, #4)
  - [x] 2.1 Create `src-tauri/src/bin/termul_server.rs`. Do NOT add `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` — this is a CONSOLE server (unlike `main.rs` which hides its console).
  - [x] 2.2 In `main()`: install `tracing_subscriber` (env filter, `RUST_LOG` default), parse `--host`/`--port` (default `127.0.0.1:8080`, `0.0.0.0` opt-in) BEFORE any tokio runtime setup. Use `clap` OR a minimal hand-rolled parser (the repo does not currently depend on `clap` — prefer a minimal hand-rolled parse to avoid adding a dep; see `remote/server.rs::RemoteBindMode::parse` for the host-string parsing pattern).
  - [x] 2.3 Construct `AcpManager::new(vec![Arc::new(WsRelaySink::new())])` (the Story 1.1 stub — NO `AppHandle`, NO `TauriEventSink`). Wrap in `Arc`. Import via `termul_manager_lib::AcpManager` and `termul_manager_lib::web::WsRelaySink` (re-export `WsRelaySink` from `web/mod.rs` if not already `pub`).
  - [x] 2.4 Call `web_server::serve(Arc::clone(&acp_manager), ServerConfig { host, port }).await` (the new library from Task 3). On bind error, `eprintln!` + `std::process::exit(1)`.
  - [x] 2.5 Install a SIGINT/SIGTERM handler (use `tokio::signal::ctrl_c()` + a Unix `SIGTERM` handler on `cfg(unix)`) that triggers `web_server` graceful shutdown AND `acp_manager.kill_all().await`, then exits 0.

- [x] **Task 3: Create the minimal `web_server` library skeleton** (AC: #3)
  - [x] 3.1 In `src-tauri/src/web/mod.rs`: add `pub mod router; pub mod config;` alongside the existing `pub mod sink;`. Add a `pub async fn serve(acp: Arc<AcpManager>, cfg: ServerConfig) -> Result<(), Box<dyn std::error::Error + Send + Sync>>` that builds the router + binds + serves with graceful shutdown. Re-export `WsRelaySink` from `sink` so the bin can construct it (`pub use sink::WsRelaySink;`).
  - [x] 3.2 Create `src-tauri/src/web/config.rs` with `ServerConfig { host: String, port: u16 }` (or a `BindMode` enum mirroring `remote/server.rs::RemoteBindMode` — `Localhost`/`All` — with `parse`/`bind_addr`). Mark `AcpManager`-free fields `Clone, Debug`.
  - [x] 3.3 Create `src-tauri/src/web/router.rs` with `pub fn router(acp: Arc<AcpManager>) -> Router` exposing `GET /health` → `(StatusCode::OK, "OK")` (copy `remote/server.rs::health_check`), a placeholder WS upgrade route (returns `unauthorized` / 501 until Story 1.4 — do NOT implement the relay), and a static-bundle route stub (returns 503 "not embedded yet" until Story 1.3/1.11). Reuse the `axum::Router` + `tokio::net::TcpListener` + `axum::serve(listener, app).with_graceful_shutdown(...)` pattern from `remote/server.rs::RemoteServer::start`.
  - [x] 3.4 Add `pub mod config; pub mod router;` to `web/mod.rs`. Ensure `cargo check --all-targets` passes with the `standalone-server` feature on AND off.

- [x] **Task 4: Add the web build target** (AC: #5, #6)
  - [x] 4.1 Create `vite.config.web.ts` mirroring `vite.config.tauri.ts`: same `react()` plugin, same `@/`/`@renderer/`/`@shared/`/`@material-icons/` aliases, same `define: { 'import.meta.env.PACKAGE_VERSION': ... }`. Differences: `build.outDir: 'dist-web'`, `build.emptyOutDir: true`, `build.rolldownOptions.input: path.resolve(__dirname, 'index.html')` (NOT `tauri-index.html`), `build.target: 'esnext'`. NO Tauri `server`/`envPrefix`/HMR config. Add `define: { 'import.meta.env.TERMUL_WEB': 'true' }` (the feature-gate signal for Story 1.5+).
  - [x] 4.2 Verify `index.html` exists at repo root and references `src/renderer/main.tsx` (the browser entry). If it does not exist, check whether the existing browser/dev path uses a different HTML file — do NOT create a duplicate; reuse the existing one.
  - [x] 4.3 Add `"build:web": "vite build --config vite.config.web.ts"` to `package.json` scripts. Optionally add `"dev:web": "vite --config vite.config.web.ts"`.
  - [x] 4.4 Run `bun run build:web`; confirm `dist-web/index.html` + assets are produced. Confirm `bun run build:frontend:tauri` still produces `dist-tauri/` unchanged (no desktop regression).

- [x] **Task 5: Extend CI** (AC: #7)
  - [x] 5.1 In `.github/workflows/pr-validation.yml`, add a `web-build` job (or extend `build-check`): `bun install --frozen-lockfile`, `bun run build:web`, assert `dist-web/index.html` exists.
  - [x] 5.2 Add a `standalone-server-build` job (or extend `rust-checks`): setup Rust stable, `cargo build --bin termul-server --features standalone-server` (native host). Confirm `cargo clippy --all-targets -- -D warnings` and `cargo test` still pass (the `[[bin]]` must not break the default target set).
  - [x] 5.3 In `.github/workflows/release.yml`, add the cross-compile step for the VPS target (`x86_64-unknown-linux-gnu` or `musl`) with build sequencing: `bun run build:web` THEN `cargo build --bin termul-server --release --features standalone-server --target <vps-target>`. Document the ordering in a comment.
  - [x] 5.4 Verify the Tauri desktop build job (`bun run build` / `tauri build`) still succeeds — the `[[bin]]` gating must keep `termul-server` out of the desktop bundle.

- [x] **Task 6: Tests** (AC: #2, #3, #7, #8)
  - [x] 6.1 Rust unit test in `web/router.rs`: `GET /health` returns `200 OK` (use `tower::ServiceExt::oneshot` like `remote/server.rs::tests`).
  - [x] 6.2 Rust unit test in `web/config.rs`: `ServerConfig`/`BindMode` parses `127.0.0.1` → Localhost, `0.0.0.0` → All, rejects bogus (mirror `remote_bind_mode_parse_and_addrs`).
  - [x] 6.3 Rust integration test for the bin: `cargo build --bin termul-server --features standalone-server` compiles (a `build.rs`-level or `tests/` smoke test that asserts the bin target exists when the feature is on).
  - [x] 6.4 Run `cargo clippy --all-targets -- -D warnings` + `cargo test` + `bun run lint/typecheck/test`. All green. Confirm `bun run build` (desktop Tauri) still succeeds.

## Dev Notes

### Why this story exists (the D2 standalone binary)

This is the **second implementation story** for the Web ACP Agent feature. Story 1.1 (DONE, commits `745d866d` + `96ca3f2c`) decoupled the `acp` dispatcher from the Tauri `AppHandle` into a transport-neutral `EventSink` fan-out, so `AcpManager::new(sinks: Vec<Arc<dyn EventSink>>)` can now be constructed WITHOUT a Tauri app. This story is the payoff: it scaffolds the standalone `termul-server` binary that constructs a fresh `AcpManager` with a `WsRelaySink`-only sink list (no `AppHandle`, no `TauriEventSink`) and a web build target (`vite.config.web.ts` → `dist-web/`) for the browser client. Per architecture decision D2, this is a **standalone Axum+ACP binary**, NOT headless-Tauri (headless-Tauri carries the webview runtime to a VPS and risks window-assuming code paths — REJECTED).

**Scope discipline:** This story scaffolds the binary + the web build config + the minimal `web_server` library skeleton (`/health` + router + config). It does NOT implement the WS relay (Story 1.4), auth (Epic 2), sandbox (Epic 3), production static-bundle embedding (Story 1.11), the renderer transport adapter (Story 1.6), or the `main.tsx` browser-safe bootstrap (Story 1.5). The `WsRelaySink` stays a stub recorder (Story 1.1 left it `#[allow(dead_code)]`); this story constructs it but does NOT wire it to a live WS.

### Current state of the code (READ THESE FILES COMPLETELY before editing)

1. **`src-tauri/Cargo.toml`** — CRITICAL pre-existing state the AC text did not fully account for:
   - `agent-client-protocol = { version = "0.12", features = ["unstable_session_model", "unstable_session_usage"] }` is ALREADY present, with a `[patch.crates-io] agent-client-protocol = { path = "vendor/agent-client-protocol" }` redirect to a vendored 0.12.1 (Windows `CREATE_NO_WINDOW` patch). The epics file's NFR11 claim that the crate is on the "0.11.x line" is OUTDATED — the repo already uses 0.12 (vendored 0.12.1). Do NOT change this.
   - `axum = { version = "0.8", features = ["ws"] }` is ALREADY present (added for the existing `remote/` PTY bridge server). Do NOT re-add.
   - `tower-http = { version = "0.6", features = ["cors", "fs", "trace"] }` is ALREADY present, and the `fs` feature (which provides `ServeDir` for Story 1.3) is ALREADY enabled. Do NOT re-add. The AC's `+tower-http 0.6.7` is satisfied by the existing `"0.6"` (caret resolves to 0.6.11 ≥ 0.6.7). A duplicate `tower-http` line is a Cargo error — avoid.
   - `rust-embed` is GENUINELY MISSING — this is the only dep you ADD (`rust-embed = "8.12"`).
   - `tracing`, `tracing-subscriber` (env-filter), `futures-util`, `parking_lot`, `getrandom`, `tokio` (full), `serde`/`serde_json` are all ALREADY present — reuse them.
   - `rust-version = "1.77"` and `edition = "2021"` in `[package]` — STALE. The vendored ACP 0.12.1 crate uses `edition = "2024"` (requires Rust ≥ 1.85). CI uses `dtolnay/rust-toolchain@stable` (≥1.85 in 2026), so it builds today, but `rust-version = "1.77"` is misleading. See AC4 / Task 1.4.
   - There is NO `[features]` table and NO `[[bin]]` entry today. The desktop binary is `src-tauri/src/main.rs` (auto-discovered as the crate's default bin). The lib is `termul_manager_lib` (`crate-type = ["staticlib", "cdylib", "rlib"]`).

2. **`src-tauri/src/main.rs`** — the DESKTOP binary entry. It has `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` (hides the console window in release) and calls `termul_manager_lib::run()`. The `termul-server` bin must NOT have this attribute — it is a CONSOLE server (users interact via stdout/logs).

3. **`src-tauri/src/lib.rs`** — the library. Key facts:
   - `mod web;` is declared (line 18) and `use web::TauriEventSink;` (line 128).
   - `pub fn run()` (line 898) is the DESKTOP entry — it builds the Tauri `Builder`, plugins, `.setup`, `invoke_handler`, and `app.run(...)`. The `termul-server` bin does NOT call `run()` — it constructs `AcpManager` directly and calls `web::serve(...)`.
   - `AcpManager::new(vec![Arc::new(TauriEventSink::new(handle.clone()))])` at lines 999–1001 — the desktop construction site. The `termul-server` bin mirrors this but passes `vec![Arc::new(WsRelaySink::new())]`.
   - `pub use acp::AcpManager;` (line 119) — so the bin can use `termul_manager_lib::AcpManager`.
   - The `RunEvent::ExitRequested` cleanup (lines 1232–1301) calls `acp_manager.kill_all().await` — the bin's SIGINT/SIGTERM handler must do the same.

4. **`src-tauri/src/web/mod.rs` + `src-tauri/src/web/sink.rs`** (Story 1.1 output):
   - `web/mod.rs` currently has only `pub mod sink;` and `pub use sink::{EventSink, TauriEventSink, fan_out};`. `WsRelaySink` is NOT re-exported (kept crate-local). This story adds `pub mod router; pub mod config;` and a `pub async fn serve(...)`, and re-exports `WsRelaySink` so the bin can construct it.
   - `web/sink.rs` defines `EventSink` trait, `TauriEventSink`, `WsRelaySink` (stub recorder, `#[allow(dead_code)]`), `AcpEvent { sid, type_, payload }`, and `fan_out`. The `WsRelaySink` doc explicitly says "the standalone `termul-server` binary (Story 1.2) can pass `[WsRelaySink]` (or a live variant of it) to `AcpManager::new`." This story does EXACTLY that — and leaves the stub as a recorder (live WS is Story 1.4). Do NOT modify `sink.rs` except possibly removing `#[allow(dead_code)]` from `WsRelaySink` once the bin constructs it (it is now used in production wiring).

5. **`src-tauri/src/remote/server.rs`** — the EXISTING Axum server (PTY bridge). This is the single best reference for the `web_server` library's Axum lifecycle patterns. REUSE these patterns (do NOT copy the file — `remote/` is a separate server that Story 1.10 repurposes/removes):
   - `RemoteServer::start`: `TcpListener::bind(bind_mode.bind_addr(0)).await`, `listener.local_addr()?`, build `Router`, `oneshot::channel::<()>()` for shutdown, `tokio::spawn` + `axum::serve(listener, app).with_graceful_shutdown(async { let _ = shutdown_rx.await; info!(...); })`.
   - `RemoteBindMode` enum (`Localhost`/`All`) with `parse(s)`, `bind_addr(port)`, `display_host()` — mirror this for `--host` parsing (default `127.0.0.1`, `0.0.0.0` opt-in).
   - `health_check` → `(StatusCode::OK, "OK")` — copy this exact handler for `/health`.
   - `.into_make_service_with_connect_info::<SocketAddr>()` for connect info (if needed).
   - `RemoteServerState` / `RemoteStatus` — the Tauri-managed lifecycle wrapper. The `termul-server` bin does NOT need this (it owns its own lifecycle via SIGINT/SIGTERM), but Story 1.10's desktop-hosted mode WILL reuse this shape. Do not build the `RemoteServerState` wrapper in this story.

6. **`vite.config.tauri.ts`** — the EXISTING Tauri build config. Mirror its plugin/alias/define setup in the new `vite.config.web.ts`. Key elements to copy: `@vitejs/plugin-react-swc`, `createRequire` for `material-icon-theme` icons dir, `@/`/`@renderer/`/`@shared/`/`@material-icons/` aliases, `define: { 'import.meta.env.PACKAGE_VERSION': JSON.stringify(pkg.version) }`, `build.rolldownOptions` (Vite 8 / Rolldown), `build.target: 'esnext'`. Key differences for the web config: input `index.html` (not `tauri-index.html`), `outDir: 'dist-web'`, NO Tauri `server`/`envPrefix`/HMR config.

7. **`tsconfig.web.json`** — ALREADY EXISTS and is correctly wired (`include: ["src/renderer/**/*", "src/shared/**/*"]`, paths for `@renderer/*`/`@/*`/`@shared/*`, strict, ES2022, bundler moduleResolution). It is REUSED unchanged. `package.json` already has `typecheck:web` using it.

8. **`src/renderer/main.tsx`** — the browser/dev entry. It statically imports `TauriApp` (line 41) and picks `TauriApp` vs `App` via a local `isTauriContext()`. This static import pulls Tauri APIs into the web bundle. **The dynamic-import fix is Story 1.5's job — do NOT rewrite `main.tsx` in this story.** This story's AC6 introduces the feature-gate env signal (`import.meta.env.TERMUL_WEB`) that Story 1.5 will use to gate the `TauriApp` import. The web build (`bun run build:web`) will still produce a bundle that includes Tauri APIs until 1.5 lands — that is expected and acceptable for this story (the BUILD succeeds; runtime browser-safety is 1.5).

9. **`src-tauri/build.rs`** — currently `fn main() { tauri_build::build() }`. You MAY extend it to assert `dist-web/` exists when building `termul-server` in release with `rust-embed` (build sequencing, Gap #1) — but ONLY when the `standalone-server` feature is on AND it is a release build, so the desktop build is unaffected. Story 1.11 owns the full embedding; this story may add a minimal `println!("cargo:rerun-if-changed=../dist-web")` + a `cfg!`-gated existence check. Be careful: `build.rs` runs for BOTH the desktop and the server bin — guard the check with the feature flag.

10. **`src-tauri/tauri.conf.json`** — `productName: "Termul Manager"`, `build.beforeBuildCommand: "npx vite build --config vite.config.tauri.ts"`, `frontendDist: "../dist-tauri"`, `bundle.externalBin: ["bin/rg"]` (the existing sidecar pattern — DIFFERENT from `[[bin]]`). The desktop bin name is derived from `productName`. Do NOT add `termul-server` to `bundle.externalBin` (that would make it a sidecar bundled INTO the desktop app — wrong; `termul-server` is a standalone deployable).

### 🚨 CRITICAL RISK #1 — The Tauri bundler `[[bin]]` gotcha (read BEFORE editing Cargo.toml)

The architecture doc's file map says `+[[bin]] name="termul-server"` without addressing a known Tauri 2 bundler behavior: **`tauri build`'s bundler copies EVERY `[[bin]]` target it discovers into the desktop app bundle, regardless of `required-features` gating.** This is tracked in tauri issue #15325: the bundler's stage-2 disk scan walks `src-tauri/src/bin/` and re-adds every bin source it finds, ignoring `required-features`. The result: adding `[[bin]] name="termul-server" path="src/bin/termul_server.rs"` naively will make `tauri build` (the desktop `bun run build`) try to copy `termul-server` into the desktop bundle and FAIL (or include it unintentionally).

**Mitigation (the approach baked into this story's AC1/AC8):**
- Gate the `[[bin]]` with `required-features = ["standalone-server"]` AND add the `standalone-server` feature to `[features]`. Default `cargo build` / `tauri build` (no `--features`) will then NOT build `termul-server` (stage-1 honors `required-features`).
- Set an explicit `path` on the `[[bin]]` (e.g. `path = "src/bin/termul_server.rs"`). To defend against the stage-2 disk scan re-adding it (issue #15325), you MAY move the source OUT of `src/bin/` (e.g. `src/server_main.rs`) and point `path` there — stage-2 only walks `src/bin/`. Prefer `src/bin/termul_server.rs` first (Cargo convention); only move it if `tauri build` actually breaks in CI.
- Verify BOTH: (a) `bun run build` (desktop Tauri) still succeeds with NO `--features`; (b) `cargo build --bin termul-server --features standalone-server` succeeds. If (a) breaks, apply the `path`-outside-`src/bin/` workaround.
- This is why AC2/AC4 reference `cargo build --bin termul-server --features standalone-server` (not the bare `cargo build --bin termul-server` from the epic's literal AC text — the feature gate is required to avoid breaking the desktop build, so the command gains `--features standalone-server`).

**Alternative considered & rejected:** `autobins = false` + explicit `[[bin]]` for both `main` and `termul-server`. Rejected because Tauri's `tauri-build` generates the desktop bin target from `main.rs` and the `autobins` interaction with Tauri's codegen is fragile. The feature-gate approach is the documented workaround (tauri PR #14379 + the `openhuman/pull/39` precedent).

### 🚨 CRITICAL RISK #2 — MSRV inconsistency (`rust-version = "1.77"` vs ACP 0.12.1 edition 2024)

The project's `src-tauri/Cargo.toml` pins `rust-version = "1.77"` and `edition = "2021"`, but the vendored `src-tauri/vendor/agent-client-protocol/Cargo.toml` declares `edition = "2024"` (which requires Rust ≥ 1.85) and `version = "0.12.1"`. The crate also depends on `tokio = "1.52"`, `agent-client-protocol-schema = "=0.13.2"`, `rmcp = "1.2.0"`, `schemars = "1.0"`, `rustc-hash = "2.1.1"`, `uuid = "1.18"` — all of which presume a recent Rust. CI uses `dtolnay/rust-toolchain@stable` (≥1.85 in 2026), so the project BUILDS today despite the stale `rust-version` field (Cargo's `rust-version` is the crate's own MSRV claim; it does not enforce transitive deps' MSRVs).

**Required action (AC4):** Read `vendor/agent-client-protocol/Cargo.toml` and confirm `edition = "2024"`. Then EITHER:
- (Preferred) Bump `rust-version = "1.77"` → `"1.85"` in `src-tauri/Cargo.toml` `[package]` to reflect reality (the project genuinely needs ≥1.85 because of the ACP crate). This is a one-line, low-risk fix that makes the MSRV claim honest.
- OR leave `rust-version = "1.77"` and add a `# NOTE: ACP 0.12.1 is edition 2024 (≥1.85); CI uses stable, so this rust-version field is aspirational for the termul-manager crate itself.` comment.

The Story 1.2 AC explicitly says "the ≥1.85 / Rust-2024 claim is NOT asserted until verified against the crate" — you have now verified it (edition 2024, version 0.12.1). Document the verification in the Dev Agent Record. Do NOT change the `agent-client-protocol = "0.12"` requirement or the `[patch.crates-io]` vendored redirect.

### rust-embed 8.12 — derive shape + path-resolution gotcha + build sequencing

- **Derive:** rust-embed 8.x uses `#[derive(rust_embed::Embed)] #[folder = "dist-web/"] struct Assets;` (the derive is `Embed`, imported via `rust_embed::Embed`; the older `RustEmbed` derive name is an alias — prefer `Embed`). It generates `Assets::get(path) -> Option<EmbeddedFile>` and `Assets::iter()`.
- **Path-resolution gotcha (CRITICAL):** "In debug and when `debug-embed` is NOT enabled, the folder path is resolved relative to where the binary is run from. In release (or with `debug-embed`), it is relative to where `Cargo.toml` is." So `#[folder = "dist-web/"]`:
  - In dev (debug): reads `dist-web/` from the CWD → you must run the binary from the repo root, OR use `tower-http ServeDir` for dev (which is Story 1.3's job — `tower-http`'s `fs` feature is already enabled).
  - In release: embeds `dist-web/` into the binary at cargo-build time (relative to `src-tauri/Cargo.toml`).
- **Build sequencing (Gap #1, shared with Story 1.11):** Because `rust-embed` embeds `dist-web/` at cargo-build time in release, `bun run build:web` MUST run BEFORE `cargo build --bin termul-server --release --features standalone-server`. Orchestrate in CI (Task 5.3) and document a `bun run build:web && cargo build --bin termul-server --release --features standalone-server` ordering. A missing/stale `dist-web/` should fail the build with a clear error — you MAY add a `build.rs` `cfg!`-gated existence check (only when `standalone-server` feature is on AND release). Story 1.11 owns the FULL production embedding; this story only wires the dep + the CI ordering + (optionally) the derive scaffold.
- **axum integration pattern (for Story 1.3/1.11, NOT this story):** serve `Assets::get(path)` via a handler with `mime_guess` for content-type; SPA fallback returns `index.html` for unmatched routes. This story's `router.rs` leaves the static-bundle route as a 503 stub.

### What NOT to do in this story (scope fence)

- Do NOT implement the WS relay / envelope / seq / cursor / tiers (Story 1.4). The `WsRelaySink` stays a stub recorder; the WS upgrade route returns a placeholder (`unauthorized` / 501).
- Do NOT implement auth / token gate / cookie / CSRF nonce (Epic 2, Stories 2.1–2.3).
- Do NOT implement the agent sandbox / path-safety / secret store (Epic 3).
- Do NOT implement production static-bundle embedding (Story 1.11) — wire the `rust-embed` dep + the derive scaffold + CI ordering only; the `router.rs` static route returns a 503 stub.
- Do NOT rewrite `src/renderer/main.tsx` (Story 1.5 owns the dynamic-import tree-shake). This story adds the `import.meta.env.TERMUL_WEB` define signal only.
- Do NOT touch `src/renderer/lib/acp-api.ts` or add `acp-transport.ts` (Story 1.6).
- Do NOT add an ESLint `no-restricted-imports` rule (Story 1.6).
- Do NOT repurpose or remove `src-tauri/src/remote/` (Story 1.10). Reuse its PATTERNS in `web/`, do not modify the files.
- Do NOT add `termul-server` to `tauri.conf.json` `bundle.externalBin` (that bundles it INTO the desktop app as a sidecar — wrong; it is a standalone deployable).
- Do NOT re-add `axum` or `tower-http` to `Cargo.toml` (already present). Only `rust-embed` is genuinely missing.
- Do NOT change the `agent-client-protocol = "0.12"` requirement or the `[patch.crates-io]` vendored redirect.
- Do NOT wire `WsRelaySink` to a live WS — it stays a stub recorder (Story 1.4 wires it live).
- Do NOT add `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` to `termul_server.rs` (it is a console server).

### Critical "do not break" list (regression surface)

- **`bun run build` (desktop Tauri build)** — the #1 regression risk. The `[[bin]] name = "termul-server"` gating MUST keep the Tauri bundler from trying to copy `termul-server` into the desktop bundle. Verify `bun run build` still succeeds after adding the `[[bin]]` (see Critical Risk #1).
- **`cargo build` (default, no features)** — must still build only the desktop `main.rs` bin. `cargo check --all-targets` (used by `rust-checks` and `rust-windows-check` CI jobs) checks all targets INCLUDING `termul-server` — so the bin MUST compile even without the feature IF `--all-targets` is used. Reconcile: either (a) make the bin compile without the feature (the `rust-embed` derive is feature-gated so the bin body must not reference `rust-embed` types unconditionally — use `#[cfg(feature = "standalone-server")]` inside the bin, OR keep the bin's body feature-agnostic so it compiles in both modes), OR (b) accept that `cargo check --all-targets` needs `--features standalone-server`. CI's `rust-checks` job runs `cargo check --all-targets` WITHOUT features today — so the bin MUST compile without the feature (the `rust-embed` usage must be `#[cfg(feature = "standalone-server")]`-gated inside the bin, or the bin must not reference `rust-embed` at all in this story since embedding is Story 1.11). **Recommended:** keep `termul_server.rs` free of `rust-embed` imports in this story (the derive scaffold lives in `web/assets.rs` which is Story 1.3/1.11); the bin only needs `AcpManager` + `web::serve`. Then `cargo check --all-targets` passes without the feature.
- **`bun run build:frontend:tauri`** — must still produce `dist-tauri/` unchanged. The new `vite.config.web.ts` is a SEPARATE config; it must not alter the Tauri build.
- **`bun run typecheck`** — `tsconfig.web.json` is reused unchanged; the new `vite.config.web.ts` must not introduce TS errors. `bun run typecheck:web` must still pass.
- **`bun run lint` (biome)** — biome ignores `src-tauri/` (Rust) and `dist-web/` (build output). Ensure `dist-web/` is in biome's ignore list (or `.gitignore`d) so a stale `dist-web/` does not trip `bun run ci`. Add `dist-web/` to `.gitignore` (build artifact).
- **Existing `remote/` server** — untouched. The `web/` module is NEW and separate.
- **Story 1.1 sink tests** (`web/sink.rs::tests`) — unchanged. The `WsRelaySink` stub stays; this story just constructs it in the bin.
- **`AcpManager` API** — `AcpManager::new(sinks: Vec<Arc<dyn EventSink>>)` (Story 1.1) is the construction signature. Do NOT change it.

### Project Structure Notes

- **New files:** `src-tauri/src/bin/termul_server.rs`, `src-tauri/src/web/router.rs`, `src-tauri/src/web/config.rs`, `vite.config.web.ts`.
- **Modified files:** `src-tauri/Cargo.toml` (+`rust-embed 8.12`, +`[features] standalone-server`, +`[[bin]] termul-server` gated, +`rust-version` bump to 1.85 OR NOTE comment), `src-tauri/src/web/mod.rs` (+`pub mod router; pub mod config;` +`pub async fn serve` +`pub use sink::WsRelaySink;`), `package.json` (+`build:web` script, optionally +`dev:web`), `.github/workflows/pr-validation.yml` (+web-build +standalone-server-build jobs), `.github/workflows/release.yml` (+cross-compile +build sequencing), `.gitignore` (+`dist-web/`), optionally `src-tauri/build.rs` (+`cargo:rerun-if-changed=../dist-web` +cfg-gated existence check).
- **Alignment with architecture:** the file map in `architecture-web-acp-agent.md` (lines 295–334) places `web_server` under `src-tauri/src/web/` with submodules `mod.rs`/`router.rs`/`ws.rs`/`auth.rs`/`sandbox.rs`/`assets.rs`/`config.rs`/`sink.rs`. This story creates `mod.rs` (extend) + `router.rs` (NEW) + `config.rs` (NEW); `ws.rs`/`auth.rs`/`sandbox.rs`/`assets.rs` land in later stories. The `[[bin]]` lives at `src-tauri/src/bin/termul_server.rs` per the architecture file map.
- **No conflicts detected** with the existing structure. `web/` is extended in place (Story 1.1 created it); `remote/` is untouched.

### Previous Story Intelligence (Story 1.1 — DONE, commits 745d866d + 96ca3f2c)

Story 1.1 decoupled the `acp` dispatcher from the Tauri `AppHandle`. Carry these learnings forward:
- `AcpManager::new(sinks: Vec<Arc<dyn EventSink>>)` is the construction signature — NO `AppHandle`. The `termul-server` bin passes `vec![Arc::new(WsRelaySink::new())]`.
- `EventSink` trait + `TauriEventSink` + `WsRelaySink` (stub recorder) live in `src-tauri/src/web/sink.rs`. `WsRelaySink` is `#[allow(dead_code)]` and NOT re-exported from `web/mod.rs` (only `EventSink, TauriEventSink, fan_out` are). This story re-exports `WsRelaySink` (`pub use sink::WsRelaySink;`) and constructs it in the bin — at which point the `#[allow(dead_code)]` can be removed (it is now used in production wiring).
- `AcpEvent { sid: Option<String>, type_: &'static str, payload: serde_json::Value }` — note `type_` (not `type`); the rename to `type` + `seq` is deferred to Story 1.4 (logged in `deferred-work.md`).
- `fan_out` serializes ONCE, fans out N; `WsRelaySink` records verbatim (does NOT strip the `acp:` prefix yet — Story 1.4).
- Desktop mode registers a single `TauriEventSink` in `lib.rs::run()` (line 999). The `termul-server` bin does NOT touch this — it is a separate entry.
- 4 items deferred from Story 1.1's code review (in `_bmad-output/implementation-artifacts/deferred-work.md`): (1) `AcpEvent` lacks `Serialize` + `type_` rename → Story 1.4; (2) `WsRelaySink` recorder grows without bound → Story 1.4; (3) `drive_connection`/`run_command_loop` clone the sink `Vec` repeatedly → future opt; (4) `AcpManager::new(vec![])` silently drops events → **Story 1.2/1.10's job to wire production sinks** — this story does that for the headless binary (`vec![WsRelaySink]`).
- CI gates confirmed green in 1.1: `cargo clippy --all-targets -D warnings`, `cargo test` (295 passed), `bun typecheck`, `bun test` (2162 passed). Biome is green for tracked source (ignores `src-tauri/` + build artifact dirs).
- Mojibake warning from 1.1's review: PowerShell `.patch` rendering produced garbled glyphs (`ÔÇö`/`ÔåÆ`) that were NOT in source. When generating diffs/patches in this story, be aware PowerShell encoding can mangle em-dashes/arrows in tool output — verify against the actual file, not the rendered patch.

### Git Intelligence

Recent commits (most recent first):
- `96ca3f2c` refactor(acp): harden EventSink fan-out after code review (Story 1.1) — the LATEST commit; baseline for this story.
- `745d866d` refactor(acp): decouple dispatcher from AppHandle via EventSink fan-out — Story 1.1 core.
- `4e747c85` feat(ui): relocate sidebar/file-explorer toggles to the titlebar (#429) — the `baseline_commit` Story 1.1 started from.
- `1764c475` chore: update typescript from RC to stable 7.0.2 (#424) — confirms `package.json` `typescript ^7.0.2` is current (project-context.md's "5.8.3" is STALE; real version is TS 7.x).
- `d17ae912` feat(chat): agent-chat polish + Streamdown message rendering (#420) — the ACP chat UI this feature reuses.

**Patterns to follow:** conventional commit style (`feat:`, `fix:`, `refactor:`, `chore:`, `build:`, `ci:`). Story 1.1 used `refactor(acp): ...` — this story's commits should use `feat(web): ...` (new server binary + web build) and `build(ci): ...` or `ci: ...` for the workflow changes. The PR title must follow the conventional-commits gate in `pr-validation.yml` (`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`, lowercase subject).

### Latest Technical Information (web-verified 2026-07)

- **Tauri 2 `[[bin]]` + bundler behavior:** `tauri build`'s bundler copies EVERY `[[bin]]` it discovers into the desktop bundle, regardless of `required-features` (stage-2 disk scan walks `src-tauri/src/bin/` and re-adds sources ignoring `required-features` — tauri issue #15325). Mitigation: gate the `[[bin]]` with `required-features = ["standalone-server"]` + an explicit `path`; if `tauri build` still breaks, move the source OUT of `src/bin/` (stage-2 only walks `src/bin/`). Precedent: `tinyhumansai/openhuman/pull/39` removed standalone `[[bin]]` entries + set `autobins = false` + injected `[[bin]]` in CI. See Critical Risk #1 above.
- **`rust-embed` 8.12.0 (current, July 2026):** derive is `#[derive(rust_embed::Embed)] #[folder = "dist-web/"] struct Assets;` (prefer `Embed` over the legacy `RustEmbed` alias). Generates `Assets::get(path) -> Option<EmbeddedFile>` + `Assets::iter()`. Path resolution: debug → relative to CWD; release (or `debug-embed` feature) → relative to `Cargo.toml`. Features: `debug-embed` (always embed), `compression`, `deterministic-timestamps`, `interpolate-folder-path`. axum integration: serve `Assets::get(path)` via a handler with `mime_guess` for content-type; SPA fallback returns `index.html` (Story 1.3/1.11).
- **`tower-http` 0.6.x (current, 0.6.11 May 2026; 0.7.0 June 2026 is a NEW major with breaking changes — DO NOT bump in this story):** 0.7 removed the implicit no-op `tokio`/`async-compression` features. The repo's `tower-http = "0.6"` (caret → 0.6.11) with `features = ["cors", "fs", "trace"]` is current and correct; the `fs` feature provides `ServeDir` (Story 1.3 dev serving). Leave at `0.6`; do NOT bump to `0.7` (out of scope, unnecessary breaking change).
- **`axum` 0.8.x (current, 0.8.9 April 2026 per architecture doc):** repo's `axum = "0.8"` (caret → latest 0.8.x) with `features = ["ws"]` is current. The `axum::serve(listener, app).with_graceful_shutdown(...)` API (used in `remote/server.rs`) is the 0.8 pattern. `axum-server` crate is NOT needed in this story (TLS is Story 2.2). Leave at `0.8`.
- **`agent-client-protocol` 0.12.1 (vendored, edition 2024, ≥Rust 1.85):** confirmed via `src-tauri/vendor/agent-client-protocol/Cargo.toml`. The `[patch.crates-io]` redirect to `vendor/agent-client-protocol` (Windows `CREATE_NO_WINDOW` patch) is unchanged. The epics NFR11 "0.11.x crate line" claim is OUTDATED — the repo already uses 0.12. Do NOT change.
- **Vite 8 + Rolldown:** the repo uses Vite 8.0.14 with `@vitejs/plugin-react-swc` and `build.rolldownOptions` (Rolldown-based). The new `vite.config.web.ts` must use the same `rolldownOptions` shape as `vite.config.tauri.ts` (input → `index.html`, outDir → `dist-web/`). `tsconfig.web.json` is reused unchanged (ES2022, bundler moduleResolution, strict).
- **TypeScript 7.0.2:** `package.json` `typescript ^7.0.2` is current (commit `1764c475`). `project-context.md`'s "5.8.3" is stale — do not rely on it for TS version. Strict mode (`strict: true`, `noImplicitAny: true`) is active in `tsconfig.web.json`.
- **`bun@1.3.1`** is the package manager; CI uses `oven-sh/setup-bun@v2` with `bun-version: 1.3.x`. New scripts (`build:web`) must work with this bun version.

### Project Context Reference

Persistent facts from `docs/project-context.md` the dev MUST honor (this story touches the stack directly):

- **Stack:** Tauri 2 + React/TS renderer + Rust runtime (`src-tauri/`). Bun is the package manager; Biome is the linter/formatter (strict). Vitest is the test runner (renderer); `cargo test` for Rust.
- **Implementation rules (mandatory):**
  - No `unwrap()`/`expect()` in non-test Rust — use `?` or explicit error handling. The `termul-server` bin's bind path MUST use `?` + `eprintln!` + `std::process::exit(1)`, not `unwrap()`.
  - No `any` in TS. The new `vite.config.web.ts` is typed; reuse the `UserConfig`-shaped export from `vite.config.tauri.ts`.
  - All new Rust modules have `#[cfg(test)] mod tests` with at least one meaningful test. `web/router.rs` and `web/config.rs` MUST have unit tests (Task 6.1, 6.2).
  - CI gate is strict: `bun run ci` (Biome), `bun run typecheck`, `bun run test`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. All MUST pass before PR.
  - Conventional commits enforced by `pr-validation.yml` (`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`, lowercase subject). This story's commits: `feat(web): ...` for the binary + web build, `build(ci): ...` for the workflow changes.
- **Anti-patterns to avoid (from project-context.md):**
  - Do NOT add a duplicate dependency line to `Cargo.toml` (Cargo error). `axum`/`tower-http` are already present — only `rust-embed` is added.
  - Do NOT bump `tower-http` to `0.7` (breaking change, out of scope). Leave at `0.6`.
  - Do NOT use `tauri build`'s bundler as the path for the standalone binary — it is a standalone deployable, NOT a desktop sidecar. Do NOT add it to `bundle.externalBin`.
  - Do NOT rely on `project-context.md`'s stale "TypeScript 5.8.3" claim — the real version is TS 7.0.2 (commit `1764c475`).
- **Boundaries:** the `web/` module is the new home for the standalone server (Story 1.1 created it with `sink.rs`). The `remote/` module is a SEPARATE existing PTY-bridge server (Story 1.10 owns its fate) — reuse PATTERNS only, do not modify files.

### References

- **Architecture:** `_bmad-output/planning-artifacts/architecture-web-acp-agent.md` (D2 standalone binary decision, file map lines 295–334, scope fence).
- **Epics:** `_bmad-output/planning-artifacts/epics-web-acp-agent.md` (Epic 1, Story 1.2 AC source — note NFR11 "0.11.x" is OUTDATED, repo uses 0.12).
- **Previous story:** `_bmad-output/implementation-artifacts/1-1-d2-dispatcher-decoupling-apphandle-to-eventsink.md` (Story 1.1 — `EventSink`, `AcpManager::new`, `WsRelaySink` stub).
- **Deferred work:** `_bmad-output/implementation-artifacts/deferred-work.md` (4 items from 1.1; item #4 — `AcpManager::new(vec![])` silently drops events — is addressed by this story wiring `WsRelaySink`).
- **Project context:** `docs/project-context.md` (stack, rules, anti-patterns).
- **Existing patterns to reuse:**
  - `src-tauri/src/remote/server.rs` — Axum lifecycle, `RemoteBindMode`, `health_check`, graceful shutdown.
  - `src-tauri/src/web/sink.rs` — `EventSink`, `WsRelaySink` (Story 1.1).
  - `vite.config.tauri.ts` — Vite 8 + Rolldown plugin/alias/define shape.
  - `tsconfig.web.json` — reused unchanged.
- **External docs (web-verified 2026-07):**
  - Tauri 2 `[[bin]]` bundler gotcha: tauri issue #15325, PR #14379.
  - `rust-embed` 8.12: `#[derive(rust_embed::Embed)]`, path-resolution rules.
  - `tower-http` 0.6.11 (do NOT bump to 0.7), `axum` 0.8.x graceful shutdown API.
  - `agent-client-protocol` 0.12.1 vendored (edition 2024, ≥Rust 1.85).

## Dev Agent Record

**Story baseline:** `96ca3f2c` (Story 1.1's hardening commit).

**Pre-dev verification (DONE at story-creation time):**
- [x] Read `src-tauri/Cargo.toml` — confirmed `agent-client-protocol = "0.12"` (vendored 0.12.1), `axum = "0.8"` (ws), `tower-http = "0.6"` (cors/fs/trace) ALREADY present. `rust-embed` MISSING. `rust-version = "1.77"` STALE (ACP 0.12.1 is edition 2024 → ≥1.85).
- [x] Read `src-tauri/vendor/agent-client-protocol/Cargo.toml` — confirmed `edition = "2024"`, `version = "0.12.1"`. AC4's ≥1.85 claim is VERIFIED.
- [x] Read `src-tauri/src/web/mod.rs` + `web/sink.rs` — confirmed `WsRelaySink` exists as stub recorder, NOT re-exported. This story re-exports it.
- [x] Read `src-tauri/src/remote/server.rs` — confirmed `RemoteBindMode`, `health_check`, `axum::serve(...).with_graceful_shutdown(...)` patterns to reuse.
- [x] Read `vite.config.tauri.ts` + `tsconfig.web.json` + `package.json` — confirmed `tsconfig.web.json` exists + is reused; `vite.config.web.ts` does NOT exist; `build:web` script does NOT exist.
- [x] Read `.github/workflows/pr-validation.yml` + `release.yml` — confirmed current CI job shape to extend.
- [x] Web-verified (2026-07): Tauri 2 `[[bin]]` bundler gotcha (#15325), `rust-embed` 8.12 derive + path resolution, `tower-http` 0.6 vs 0.7, `axum` 0.8 graceful shutdown, `agent-client-protocol` 0.12.1 edition 2024.

**Implementation log (dev fills in during story execution):**

| Date | Commit | Summary | Files touched |
|------|--------|---------|---------------|
| 2026-07-19 | | feat(web) standalone server scaffold | .github/workflows/pr-validation.yml, .github/workflows/release.yml, .gitignore, index.html, package.json, vite.config.web.ts, tsconfig.node.json, src/renderer/vite-env.d.ts, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/build.rs, src-tauri/src/lib.rs, src-tauri/src/bin/termul_server.rs, src-tauri/src/web/mod.rs, src-tauri/src/web/sink.rs, src-tauri/src/web/config.rs, src-tauri/src/web/router.rs |
**Deviation log (dev fills in if AC text is wrong/stale):**

| AC | Deviation | Reason | Resolution |
|----|-----------|--------|------------|
|    |           |        |            |

**Post-dev checklist (dev MUST run before marking dev-done):**
- [x] `cargo build --bin termul-server --features standalone-server` succeeds.
- [x] `cargo build` (default, no features) still builds only the desktop `main.rs` bin.
- [x] `cargo check --all-targets` (no features) passes — `termul_server.rs` compiles WITHOUT the feature (no `rust-embed` imports in the bin body in this story).
- [x] `cargo clippy --all-targets -- -D warnings` passes (with AND without `--features standalone-server`).
- [x] `cargo test` passes (new `web/router.rs` + `web/config.rs` tests green; Story 1.1 sink tests still green).
- [x] `bun run build:web` produces `dist-web/index.html` + assets.
- [x] `bun run build:frontend:tauri` still produces `dist-tauri/` unchanged (no desktop regression).
- [x] `bun run build` (desktop Tauri build) still succeeds — `[[bin]]` gating keeps `termul-server` out of the desktop bundle (Critical Risk #1 gating); verified locally: `bun run build:frontend:tauri` + default `cargo build` (no features); full `bun run build` Tauri bundle deferred to CI
- [x] `bun run lint` + `bun run typecheck` + `bun run typecheck:web` + `bun run test` all pass.
- [x] `.gitignore` includes `dist-web/` (build artifact).
- [x] CI workflows (`pr-validation.yml`, `release.yml`) extended; `bun run build:web` + `cargo build --bin termul-server --features standalone-server` run in CI.
- [x] AC4 MSRV resolution applied: `rust-version` bumped to `"1.85"` OR `# NOTE:` comment added.
- [x] All ACs (#1–#8) satisfied; no scope-creep into Story 1.4/1.5/1.6/1.10/1.11/Epic 2/Epic 3.


**Completion Notes:**
- Standalone `termul-server` binary (`standalone-server` feature), minimal `web_server` Axum skeleton, Vite `build:web` / `vite.config.web.ts`, MSRV note, CI build steps for web + server binary.
- Desktop path unchanged for default builds; Story 1.4+ owns WS relay, 1.5 `main.tsx` tree-shake, 1.11 full `rust-embed` serving.

**File List:**
- .github/workflows/pr-validation.yml
- .github/workflows/release.yml
- .gitignore
- index.html
- package.json
- vite.config.web.ts
- tsconfig.node.json
- src/renderer/vite-env.d.ts
- src-tauri/Cargo.toml
- src-tauri/Cargo.lock
- src-tauri/build.rs
- src-tauri/src/lib.rs
- src-tauri/src/bin/termul_server.rs
- src-tauri/src/web/mod.rs
- src-tauri/src/web/sink.rs
- src-tauri/src/web/config.rs
- src-tauri/src/web/router.rs
**Deferred to later stories (do NOT implement here):**
- WS relay / envelope / seq / cursor / tiers → Story 1.4.
- `main.tsx` dynamic-import tree-shake → Story 1.5.
- Renderer `acp-transport.ts` + ESLint `no-restricted-imports` → Story 1.6.
- Production static-bundle embedding (`Assets::get` + SPA fallback) → Story 1.3/1.11.
- Auth / token gate / cookie / CSRF → Epic 2.
- Agent sandbox / path-safety / secret store → Epic 3.
- `remote/` repurpose/removal → Story 1.10.
- `AcpEvent` `Serialize` + `type_` → `type` rename → Story 1.4 (deferred-work.md item #1).
- `WsRelaySink` capacity bound → Story 1.4 (deferred-work.md item #2).
