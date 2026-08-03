# Web & Mobile Parity Gap Analysis + Implementation Plan

**Date:** 2026-08-02
**Scope:** Desktop (`termul-manager`) ↔ Web client (`App.tsx` + `termul-server`) ↔ Mobile (responsive web ≤767px)
**Method:** Direct source audit — `lib.rs` invoke_handler (141 Tauri commands), `web/router.rs` (15 HTTP routes + 2 WS), `web/ws.rs` (ACP WS dispatcher), `web-server-api.ts` (renderer web facade), both renderer entries, and 90 `isTauriContext()` gates.

---

## 1. Executive Summary

Termul already has a **deliberate dual-target architecture** for desktop↔web parity: two binaries sharing one crate (`termul_manager_lib`), a shared `web/` module, a shared `dist-web` bundle embedded via `rust-embed`, and renderer facades that branch on `isTauriContext()` between Tauri `invoke` and HTTP/WS implementations. The `IpcResult<T>`/`IpcBody<T>` contract (the same `{ success, data }` | `{ success, error, code }` JSON shape) is shared across all three layers — desktop commands return `IpcResult<T>`, web routes return `IpcBody<T>`.

**Parity is real and complete for the core workflow** — terminals (`/terminal/ws`), ACP agent chat (`/ws`), project listing, shell detection, project creation, basic filesystem, and MCP servers. The web client can run terminals and AI agent sessions with full fidelity.

**Parity is incomplete in four areas:**

| Area | Gap size | Impact |
| --- | --- | --- |
| Git operations | 19/20 commands have no web route | Git panel/staging/commit/history unusable on web |
| Content & file search | 6/6 commands desktop-only | ripgrep search unavailable on web |
| SSH/SFTP | 19/19 commands desktop-only | Remote host features unavailable on web |
| Worktree management | 13/13 commands desktop-only | Git worktree feature unavailable on web |

Plus renderer-level gaps (crash recovery, what's-new, error boundary, OS notifications) and mobile shell gaps (no editor/browser/git/command-palette/snapshot entry points).

The browser-tab/annotation feature (20 commands) is **intentionally desktop-only** — it relies on Tauri child webviews which cannot exist in a browser. This is correct and should not be "fixed."

---

## 2. Current Architecture (the parity framework already in place)

### 2.1 Two binaries, one crate

```
termul_manager_lib (crate)
├─ termul-manager   (src-tauri/src/main.rs)     — desktop binary, default-run
└─ termul-server    (src-tauri/src/server_main.rs) — standalone console binary
                                                      (feature: standalone-server)
```

Both consume the **shared `web/` module** (`src-tauri/src/web/`):
- Desktop: in-process via `web::serve_router` (driven by `remote/host.rs`) — never kills agents
- Standalone: via `web::serve` (in `server_main.rs`) — calls `AcpManager::kill_all` after drain

### 2.2 Shared bundle + contract

- `dist-web/` built by `vite.config.web.ts` (entry `App.tsx`, `TERMUL_WEB` gate, `@tauri-apps/*`→stubs), embedded via `rust-embed`, served by BOTH targets
- `IpcResult<T>` (`{ success, data } | { success, error, code }`) is the body shape for Tauri commands, web routes, and renderer facades
- Transport failures map to `{ success: false, code: 'NETWORK_ERROR' }`

### 2.3 Renderer facade branching

```
Component/Hook
   ↓
src/renderer/lib/*-api.ts          (facade)
   ↓ isTauriContext() ?
   ├─ true  → tauri-*-api.ts       (invoke<T>('command'))
   └─ false → web-server-api.ts    (fetch/WS → web/router.rs routes)
              web-terminal-api.ts  (/terminal/ws)
              acp-transport.ts     (/ws ACP WS client)
```

Biome **machine-enforces** this boundary: `@tauri-apps/**` imports are ERROR everywhere except `src/renderer/lib/**` and test files.

### 2.4 Mobile detection

`use-mobile-web-shell.ts`: `resolveMobileWebShell(isTauri, matchesNarrowViewport)` — true when non-Tauri AND viewport ≤767px. `WorkspaceLayout` renders `MobileChatShell` (full chrome replacement) instead of `ActivityRail` + `TitleBar` + sidebar + tab strip when active.

---

## 3. Feature Parity Matrix

### Tier 1 — Full parity (desktop ↔ web) ✅

| Feature | Desktop path | Web path | Facade |
| --- | --- | --- | --- |
| Terminal spawn/write/resize/kill | Tauri commands (13) | `/terminal/ws` WS (spawn/write/resize/kill/attach/get_cwd/get_git_branch/get_git_status/get_exit_code/add_renderer_ref/remove_renderer_ref/set_protected/update_orphan_detection) | `terminal-api.ts` → `tauri-terminal-api.ts` / `web-terminal-api.ts` |
| ACP agent chat (spawn/session/prompt/cancel/mode/model/config) | Tauri commands (19) | `/ws` WS (spawn_agent/create_session/load_session/resume_session/close_session/dispose_ephemeral_session/list_sessions/send_prompt/cancel_prompt/set_mode/set_model/set_config_option/list_agents/kill_agent/switch_project) | `acp-transport.ts` → Tauri transport / WS client |
| ACP permission + question response | `acp_respond_permission` / `acp_answer_question` commands | `/ws` `respond_permission` / `answer_question` (rendezvous: first-response-wins, TOCTOU-safe) | `acp-api.ts` |
| ACP chat history (list/open/payload/recover/cursor) | `acp_history_*` commands (6) | `/ws` `list_persisted_sessions`/`open_persisted_session`/`get_session_payload`/`recover_session_snapshot`/`get_session_cursor` + `ChatHistoryStore` | `acp-history-api.ts` |
| Shell detection | `detect_shells` / `get_default_shell` / `get_home_directory` | `/shells` (GET) → `detect_shells_inner()` | `shell-api.ts` → `webServerShell` |
| Project list (desktop-hosted mirror) | `remote_sync_projects` → `ProjectRegistry` | `/projects` (GET) | `webServerProjects` |
| Project creation (mkdir/write/git-init/ls/browse) | Tauri fs + git commands | `/fs/mkdir` `/fs/write` `/fs/ls` `/fs/browse` `/git/init` | `webServerFilesystem` / `webServerDialog` / `webServerGit` |
| Basic filesystem (read/delete/rename/copy) | Tauri fs commands | `/fs/read` `/fs/delete` `/fs/rename` `/fs/copy` | `webServerFilesystem` |
| MCP servers registry | `tauri-plugin-mcp-bridge` | `/mcp-servers` (GET/PUT) | `acp-mcp-persistence.ts` → `webServerMcpServers` |
| Clipboard | `tauri-plugin-clipboard-manager` | `navigator.clipboard` (browser API) | `clipboard-api.ts` → `browserClipboardApi` |
| Directory picker | `tauri-plugin-dialog` | `DirectoryPicker` component + `/fs/browse` | `dialog-api.ts` |

### Tier 2 — Parity gaps (desktop-only, no web fallback) ❌

#### 2A. Backend/command gaps (no web route exists)

| Domain | Desktop commands | Web route? | Notes |
| --- | --- | --- | --- |
| **Git operations** (19 of 20) | `git_get_status`, `git_get_diff`, `git_stage`, `git_unstage`, `git_discard`, `git_get_log`, `git_commit`, `git_push`, `git_get_commit_context`, `git_checkout_branch`, `git_create_branch`, `git_stash_save/list/apply/pop/drop`, `git_branch_list/switch/create` | ❌ Only `/git/init` exists | Biggest gap — Git Changes panel + Git History tab completely non-functional on web |
| **Content & file search** (6) | `search_get_rg_info`, `search_content`, `search_content_stream`, `search_content_cancel`, `search_file_names_stream`, `search_file_names_cancel` | ❌ None | ripgrep search unavailable; streaming search has no WS route |
| **SSH/SFTP** (19) | `ssh_list/save/delete/import`, `ssh_connect/disconnect/get_connections`, `ssh_port_forward_start/stop`, `sftp_list_dir/download/upload/delete/mkdir/rename`, `ssh_create_askpass`, `sftp_read/write/create_file` | ❌ None | `ssh-api.ts` early-returns on `!isTauriContext()` in 3 places |
| **Git worktrees** (13) | `worktree_list/create/remove/branches/check_dirty/remove_all_managed/parse_gitignore/create_symlinks/ensure_symlinks/archive/restore/merge_preview/merge_execute` | ❌ None | Worktree feature fully desktop-only |
| **Agent skills** (2) | `list_agent_skills_cmd`, `read_agent_skill_cmd` | ❌ None | `skills-api.ts:35` returns `[]` on web |
| **Agent registry** (1) | `agent_registry_fetch` | ❌ None | `acp-registry-catalog.ts:44` gates on `!isTauriContext()` |
| **ACP registry snapshot + binary install** (2) | `acp_fetch_registry_snapshot`, `acp_install_registry_binary` | ❌ OS-fulfilled caps (correctly server-side) | But no HTTP route to fetch/install from web client |
| **Secure storage** (3) | `secure_storage_set/get/delete` | ❌ None | OS keyring — needs server-side vault for web |
| **Data migration** (6) | `data_migration_get_version/history/run_migrations/get_schema_info/get_registered/rollback` | ❌ None | Desktop-only (Tauri store-backed) |
| **Advanced filesystem** (~12) | file watch, stat, exists, etc. | ❌ `tauri-filesystem-api.ts` has `!isTauriContext()` early-returns at 12 sites | Only the 7 project-creation methods have web fallback |
| **Log export** (4) | `reveal/export/copy/export_to_default` log commands | ❌ None | Desktop-only (logs live on host) |
| **Frontend error forwarding** (1) | `log_frontend_error` | ❌ None | Web client has no error→backend path (acknowledged gap in `project-context.md:150`) |
| **Attachment binary read** (1) | `read_attachment_bytes` | ❌ None | Composer attachments desktop-only (`composer-attachments-io.ts` 3 gates, `use-composer-attachments.ts` 4 gates) |

#### 2B. Renderer entry gaps (`TauriApp.tsx` has, `App.tsx` lacks)

| Feature | TauriApp | App (web) | Verdict |
| --- | --- | --- | --- |
| `ErrorBoundary` wrapping | ✅ (`context="App Root"`) | ❌ | Gap — web has no error boundary |
| `useCrashRecovery()` | ✅ | ❌ | Gap — no crash recovery on web |
| `useWhatsNew()` + `WhatsNewModal` | ✅ | ❌ | Gap — no changelog modal on web |
| `useTerminalExitNotification()` | ✅ | ❌ | Gap — terminal exit OS notifications missing (could use Web Notifications API) |
| `initNotificationPermissions()` | ✅ | ❌ | Gap — no notification permission init on web |
| `useRemoteProjects()` | ✅ | ❌ | Desktop-only by nature (desktop IS the server host) — correct |
| `useWindowState()` | ✅ | ❌ | Desktop-only by nature (no native window on web) — correct |
| `usePreventDefaultContextMenu()` | ✅ | ❌ (has `usePreventAltMenu` instead) | Correct — web needs browser context menu |

#### 2C. Mobile shell gaps

`MobileChatShell` (full chrome replacement at ≤767px) renders `workspaceMain` (pane content) but provides **no entry point** for:

| Feature | Desktop entry | Mobile entry | Gap? |
| --- | --- | --- | --- |
| Terminal tabs | ActivityRail + tab strip | ✅ MobileChatShell terminal list + `MobileTerminalControls` | Parity ✅ |
| Agent chat | ActivityRail | ✅ MobileChatShell `onNewChat` + ChatHistoryTab drawer | Parity ✅ |
| File explorer | Sidebar | ✅ `MobileFileExplorer` (sheet) | Parity ✅ |
| Project switcher | Sidebar | ✅ `ProjectSwitcherDrawer` | Parity ✅ |
| **Editor tabs** | ActivityRail / file-explorer open | ❌ No open-editor entry in mobile shell | Gap |
| **Browser tabs + annotations** | ActivityRail | ❌ No entry (desktop-only feature anyway) | Intentionally N/A |
| **Git Changes panel** | ActivityRail `onOpenGitChanges` | ❌ No button + no web routes | Gap (depends on 2A Git) |
| **Git History tab** | ActivityRail `onOpenGitHistory` | ❌ No button + no web routes | Gap (depends on 2A Git) |
| **Command palette** | ActivityRail | ❌ No trigger in mobile shell | Gap |
| **Snapshots** | Route `/snapshots` | ❌ No navigation entry | Gap |
| **App preferences** | Route `/preferences` | Partially disabled (`AppPreferences.tsx:775` `disabled={!isTauriContext()}`) | Gap |
| **Pane splitting** | `DropZoneOverlay` + drag | ❌ No split UI in mobile shell | Gap (but may be intentional — phone viewport) |

### Tier 3 — Intentionally desktop-only (correct, no parity needed) ✅

| Feature | Why desktop-only is correct |
| --- | --- |
| Browser tabs + annotations (20 commands) | Requires Tauri child webviews — cannot exist inside a browser |
| Native menu (suspend/restore_app_menu) | OS-native menu bar — no browser equivalent |
| Window controls (show/minimize/maximize/fullscreen/zoom) | No native window in browser |
| System tray | OS tray — no browser equivalent |
| Single-instance plugin | Desktop process concern |
| Remote server host control (start/stop/status) | The desktop IS the server host — `remote/host.rs` is desktop-only by design |
| Log file reveal/export | Logs live on the host filesystem |

---

## 4. Implementation Plan

Phased by leverage (impact ÷ effort) and dependency order. Each phase is independently shippable.

### Phase 1 — Web backend parity: Git operations (HIGHEST LEVERAGE)

**Why first:** Git is the largest feature surface with zero web parity (19 commands). The Git Changes panel and Git History tab are core IDE features. Every other gap is smaller or lower-frequency.

**Scope:** Add web routes for the 19 missing git commands; extend `git-api.ts` facade with web fallbacks.

**Files to touch:**

1. **`src-tauri/src/web/fs_api.rs`** (or new `web/git_api.rs`) — add route handlers:
   - `POST /git/status` → `git_get_status`
   - `POST /git/diff` → `git_get_diff`
   - `POST /git/stage` → `git_stage`
   - `POST /git/unstage` → `git_unstage`
   - `POST /git/discard` → `git_discard`
   - `POST /git/log` → `git_get_log`
   - `POST /git/commit` → `git_commit`
   - `POST /git/push` → `git_push`
   - `POST /git/commit-context` → `git_get_commit_context`
   - `POST /git/checkout-branch` → `git_checkout_branch`
   - `POST /git/create-branch` → `git_create_branch`
   - `POST /git/stash-save` / `stash-list` / `stash-apply` / `stash-pop` / `stash-drop`
   - `POST /git/branch-list` / `branch-switch` / `branch-create`
   - Reuse the existing `git_api.rs`/`commands.rs` git logic; wrap in `IpcBody<T>` per the `web/fs_api.rs` pattern.
   - Enforce `check_within_root` boundary (same as fs_api) for all path arguments.

2. **`src-tauri/src/web/router.rs`** — register the 19 new routes ahead of the static fallback.

3. **`src/renderer/lib/web-server-api.ts`** — add `webServerGit` methods mirroring `webServerFilesystem`:
   ```ts
   export const webServerGit = {
     async init(cwd) { ... },                          // existing
     async status(cwd) { return postJson('/git/status', { cwd }) },
     async diff(cwd, opts) { return postJson('/git/diff', { cwd, ...opts }) },
     async stage(cwd, paths) { return postJson('/git/stage', { cwd, paths }) },
     // ... 18 more
   }
   ```

4. **`src/renderer/lib/git-api.ts`** — branch each method on `isTauriContext()` like the existing `init`:
   ```ts
   status: (cwd) => isTauriContext()
     ? invoke<GitStatus>('git_get_status', { cwd })
     : webServerGit.status(cwd),
   ```

5. **Tests:** `src/renderer/lib/__tests__/git-api.web.test.ts` — extend the existing web-mode test pattern (one test per method: asserts `webServerGit.X` is called when `!isTauriContext()`). Rust: `web/git_api.rs` `#[cfg(test)]` module with `tower::ServiceExt` one-shot tests per route (mirror `router.rs` tests).

6. **Logging:** `tracing::info!`/`warn!`/`error!` at each route boundary (start/success/failure) per `project-context.md` logging rules.

**Acceptance:** Git Changes panel and Git History tab work identically in `bun run dev:web` and desktop `bun run dev`.

---

### Phase 2 — Web backend parity: Search + Skills + Error forwarding

**Scope:** Content/file search (ripgrep), agent skills, and frontend error forwarding.

**2.1 Content & file search (6 commands → 2 routes):**

The streaming commands (`search_content_stream`, `search_file_names_stream`) need a WS route, not HTTP. Two options:
- **Option A (recommended):** Reuse the existing `/terminal/ws` multiplexing pattern — add a `/search/ws` upgrade that streams results. Lower complexity than a new WS.
- **Option B:** Long-poll/SSE over HTTP for streaming; simpler but less idiomatic for this codebase.

Non-streaming commands (`search_get_rg_info`, `search_content`, `search_file_names_cancel`) map to HTTP:
- `GET /search/rg-info?cwd=` → `search_get_rg_info`
- `POST /search/content` → `search_content` (non-streaming variant)
- `POST /search/cancel` → `search_content_cancel` / `search_file_names_cancel`

**Files:**
- `src-tauri/src/web/search_api.rs` (new) — route handlers calling the existing `commands::search_*` logic
- `src-tauri/src/web/router.rs` — register routes
- `src-tauri/src/web/search_ws.rs` (new, Option A) — WS upgrade for streaming search
- `src/renderer/lib/web-server-api.ts` — `webServerSearch`
- Renderer search facade (find the existing search facade in `lib/`) — branch on `isTauriContext()`

**2.2 Agent skills (2 commands):**
- `GET /skills` → `list_agent_skills_cmd`
- `GET /skills/:id` → `read_agent_skill_cmd`
- `src/renderer/lib/skills-api.ts:35,42` — replace `return Promise.resolve([])` with `webServerSkills.list()`

**2.3 Frontend error forwarding (1 command):**
- `POST /log/frontend-error` → `log_frontend_error`
- `src/renderer/lib/log-api.ts` — add web-mode branch: `isTauriContext() ? invoke('log_frontend_error', ...) : fetch('/log/frontend-error', ...)` — closes the acknowledged gap at `project-context.md:150`.

**Acceptance:** Search panel works on web; skills list populates on web; renderer errors survive closed DevTools on web.

> _Implementation status (this PR, 2026-08-03): server-side `/search/*` routes + the `webServerSearch` helper landed, but the renderer search-facade branching + streaming `/search/ws` are deferred to a follow-up, so search is server-side-only for now (the Search panel is not yet fully wired on web). Skills list + frontend-error forwarding ARE wired end-to-end. This gap-analysis is a pre-implementation point-in-time plan (2026-08-02); implementation status lives in the code + the `_bmad-output/specs/spec-web-mobile-parity/` SPEC, not here._

---

### Phase 3 — Web UI parity (renderer entry alignment)

**Scope:** Bring `App.tsx` to feature parity with `TauriApp.tsx` for non-native features.

| Item | Implementation |
| --- | --- |
| `ErrorBoundary` | Add `<ErrorBoundary context="App Root">` wrapping in `App.tsx` (same as TauriApp). One-line import + wrap. |
| `useWhatsNew()` + `WhatsNewModal` | Add to `App.tsx` `AppEffects` + JSX. The hook should work in web mode (reads release notes — verify `tauri-release-notes.ts` has a web fallback or add one fetching from the server). |
| `useCrashRecovery()` | Add to `App.tsx`. Verify the hook's `!isTauriContext()` path — it may need a web-mode implementation (session restore from `ChatHistoryStore` instead of Tauri store). |
| `useTerminalExitNotification()` + `initNotificationPermissions()` | Add to `App.tsx`. Web fallback: use the **Web Notifications API** (`Notification.requestPermission()`) instead of `tauri-plugin-notification`. Gate inside the hook: `isTauriContext() ? tauriNotification : webNotification`. |

**Files:**
- `src/renderer/App.tsx` — add imports + hook calls + `ErrorBoundary` wrap
- `src/renderer/lib/tauri-notification-api.ts` — add `browserNotificationApi` fallback (like `clipboard-api.ts` pattern), export `notificationApi = isTauriContext() ? tauriNotificationApi : browserNotificationApi`
- `src/renderer/hooks/use-crash-recovery.ts` — audit/extend web-mode path
- `src/renderer/hooks/use-whats-new.ts` — audit/extend web-mode path

**Acceptance:** `App.tsx` mounts `ErrorBoundary`, `WhatsNewModal`, crash recovery, and terminal-exit notifications in `bun run dev:web`.

---

### Phase 4 — Mobile feature parity

**Scope:** Add mobile entry points for features the desktop ActivityRail exposes but the mobile shell doesn't.

**4.1 Mobile command palette:**
- Add a header button or gesture (long-press / FAB) in `MobileChatShell` that opens `CommandPalette` as a full-screen sheet.
- `CommandPalette` is already a component — just needs a mobile trigger + responsive sheet styling.

**4.2 Mobile editor access:**
- `MobileFileExplorer` already exists — add "Open in editor" action on file nodes (it may already have this; verify `MobileFileExplorer.tsx`).
- Ensure `PaneContent` renders `EditorPanel` / `CodeEditor` / `MarkdownEditor` correctly in the narrow viewport (check `PaneContent.tsx:78` `isMobileWebShell` gate).
- CodeMirror 6 is mobile-friendly by default; BlockNote may need touch tuning.

**4.3 Mobile Git access (depends on Phase 1):**
- Add a "Git Changes" button to `MobileChatShell` header (mirrors `onOpenGitChanges`).
- Git Changes panel should render as a full-screen sheet on mobile (responsive `react-resizable-panels` → single panel on narrow viewport).

**4.4 Mobile snapshots + preferences navigation:**
- Add menu items in the `MobileChatShell` slide-out drawer for `/snapshots` and `/preferences` routes (hash-router works regardless of shell).

**4.5 Mobile pane splitting (optional — may be intentionally deferred):**
- Phone viewports can't meaningfully split panes. Document as intentional: single-pane on mobile, splits desktop-only. If needed, a "split to new window/tab" metaphor could work, but it's low priority.

**Acceptance:** Mobile shell can open editor, command palette, git changes, snapshots, and preferences.

---

### Phase 5 — Security hardening (prerequisite for remote exposure)

**Scope:** The architecture docs repeatedly warn that `/terminal/ws`, `/ws`, and all web routes are **unauthenticated** and unsafe for public/untrusted exposure. Before parity features are exposed beyond localhost/LAN, auth must land.

**Items (per `project-context.md` + `architecture.md`):**
1. **Authentication** — the `/ws` `authenticate` request is a placeholder (accepts any token). Implement real cookie/token auth (Epic 2 per `ws.rs:24`).
2. **Authorization** — per-project/per-session access control.
3. **TLS** — HTTPS/WSS for non-localhost exposure.
4. **Sandbox hardening** — the `project_root` boundary in `fs_api::check_within_root` is the only filesystem sandbox; verify all new Phase 1/2 routes enforce it.

**This phase is gated on product decisions about remote exposure scope** (LAN-only vs tunnel vs public). It does not block Phases 1–4, which work on localhost.

---

## 5. Dependency Graph

```
Phase 1 (Git) ──────────────┐
                             ├─► Phase 4.3 (Mobile Git)
Phase 2 (Search/Skills/Log) │
                             ├─► Phase 4 (Mobile parity) — independent of 1/2
Phase 3 (Web UI parity)     │
                             └─► Phase 5 (Security) — does not block 1–4 (localhost)
```

- Phase 1 and Phase 2 are independent of each other — can run in parallel.
- Phase 3 is independent of 1/2 — can run in parallel.
- Phase 4.3 (mobile Git) depends on Phase 1 (web Git routes).
- Phase 4 (other mobile items) is independent of 1–3.
- Phase 5 is gated on product decisions, not code.

---

## 6. Validation Checklist (per phase)

Each phase must pass before merge (per `CLAUDE.md`):

```bash
bun run lint          # Biome lint
bun run typecheck     # node + web + test
bun run test          # Vitest
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test
```

Plus parity-specific:
- `bun run dev:web` — verify the feature works in the web client (no `__TAURI_INTERNALS__`)
- `bun run dev` — verify desktop is unaffected (no regression)
- Narrow-viewport responsive check (DevTools device toolbar ≤767px) for mobile phases

---

## 7. Server-Side Bridge Architecture (deep research)

### 7.1 The ACP precedent — the proof this pattern works

The ACP agent system is **already a server-side bridge**. The standalone `termul-server` owns `AcpManager` + `PtyManager` and the web client controls them entirely via the `/ws` WebSocket relay:

```
Web browser (UI only)
  ↓ /ws (spawn_agent, create_session, send_prompt, ...)
termul-server (owns the agent processes)
  ↓ ssh2/portable-pty (actual work)
OS processes
```

The server is the "ACP client-of-record" — it owns the agent processes, handles the protocol, and relays events back. The browser never touches the agent subprocess. **This same pattern can be applied to every other "desktop-only" feature** — the server runs the actual logic, the browser is just a frontend.

### 7.2 Coupling analysis — what actually depends on `AppHandle`?

For each "desktop-only" manager, I traced exactly what it uses `AppHandle` for:

| Manager | `AppHandle` usage | Real work | Bridge feasibility |
| --- | --- | --- | --- |
| **`SSHManager`** → `ProfileManager` | `app_handle.store()` (tauri-plugin-store JSON) | `serde` JSON + `keyring` crate (pure Rust) | **HIGH** — swap store → file-backed JSON (like `FileProjectRegistry`) |
| **`SSHManager`** → `SSHConnectionManager` | `app_handle.emit()` (4 sites: status, SFTP progress, port-forward) | `ssh2::Session` (pure Rust) | **HIGH** — swap emit → `WsRelaySink` event relay |
| **`SSHManager`** → `PortForwardManager` | `app_handle.emit()` (port-forward events) | `ssh2` TCP forwarding (pure Rust) | **HIGH** — swap emit → `WsRelaySink` |
| **`SSHManager`** → `credential_store` | **ZERO** — uses `keyring::Entry` directly | `keyring` crate (pure Rust) | **HIGH** — works as-is on server |
| **`MigrationManager`** | `app_handle.store()` (tauri-plugin-store) | `serde` JSON versioning | **HIGH** — swap store → file-backed |
| **`BrowserTabManager`** | `app_handle.get_window()` / `WebviewBuilder` / child webview JS | Tauri child webview creation | **LOW** — fundamentally Tauri-bound; needs headless browser replacement |
| **`TerminalEventHub`** | Already has `standalone()` constructor | `portable-pty` | **DONE** — already bridged |
| **`AcpManager`** | Already works with `WsRelaySink` (no AppHandle) | `agent-client-protocol` | **DONE** — already bridged |

**Key insight:** The SSH sub-managers use `AppHandle` for exactly two things: (1) JSON storage via `tauri-plugin-store`, and (2) event emission via `app_handle.emit()`. Both have existing server-side equivalents: file-backed stores (`FileProjectRegistry` pattern) and `WsRelaySink` (the ACP event relay). The extraction is a **trait swap**, not a rewrite.

### 7.3 Bridge patterns

Four bridge patterns, ordered by implementation cost:

#### Pattern A — Storage swap (lowest cost)

```
Desktop:  Manager → app_handle.store("file.json")  (tauri-plugin-store)
Server:   Manager → FileStore::open(path)           (file-backed JSON)

Template: FileProjectRegistry (already exists in web/project_registry.rs)
```

Applies to: `ProfileManager` (SSH profiles), `MigrationManager` (schema versions), app-settings store.

#### Pattern B — Event sink swap (low cost)

```
Desktop:  Manager → app_handle.emit("event", payload)   (Tauri event)
Server:   Manager → ws_relay.emit(session_id, payload)   (WsRelaySink → WS frame)

Template: AcpManager already does this — fan_out serializes once,
          fans to [TauriEventSink, WsRelaySink]. SSH needs the same dual-sink.
```

Applies to: `SSHConnectionManager` (status events), `PortForwardManager` (forward events), `sftp` (progress events).

**Implementation:** Introduce a trait `EventSink` (or reuse the existing `EventSink` trait from the ACP module if one exists — check `acp/events.rs`):

```rust
trait SshEventSink: Send + Sync {
    fn emit_status(&self, conn_id: &str, status: &SSHConnectionInfo);
    fn emit_sftp_progress(&self, op: &str, transferred: u64, total: u64);
    fn emit_port_forward(&self, forward_id: &str, event: &PortForwardEvent);
}
```

Then:
- `TauriSshEventSink(AppHandle)` — desktop (wraps `app_handle.emit`)
- `WsSshEventSink(Arc<WsRelaySink>)` — server (wraps `ws_relay.emit`)

`SSHManager::new(sink: Arc<dyn SshEventSink>, store: Arc<dyn ProfileStore>)` — no `AppHandle` in the signature.

#### Pattern C — WS interactive relay (medium cost)

For features that need bidirectional streaming I/O (not just request/response):

```
Web browser
  ↓ /ssh/ws (or extend /terminal/ws with "ssh" spawn type)
Server: owns the SSH session via ssh2::Session
  ↓ channel I/O relay
Remote host
```

Applies to: SSH interactive terminals, streaming search, file-watching push.

#### Pattern D — Headless execution (high cost, new subsystem)

```
Web browser (displays screenshots / DOM)
  ↓ /browser/ws (navigate, annotate, capture)
Server: headless Chrome via chromiumoxide
  ↓ CDP protocol
Headless browser instance
```

Applies to: browser tabs + annotations. This is the only pattern that requires a **new dependency** (`chromiumoxide` or `headless-chrome` crate) and a fundamentally different implementation from the desktop's Tauri child webviews.

### 7.4 Per-feature bridge feasibility matrix

| Feature | Pattern | Cost | Edge cases | Priority |
| --- | --- | --- | --- | --- |
| **Git operations** (19 cmds) | A (HTTP routes) | Low | None — server runs git CLI, returns JSON | **Phase 1** (already planned) |
| **Content/file search** (6 cmds) | C (WS streaming) + A (rg-info) | Medium | Large result sets need backpressure + cancellation; follow `terminal_ws` bounded-scrollback pattern | **Phase 2** |
| **Agent skills** (2 cmds) | A (HTTP routes) | Trivial | None — server reads SKILL.md files | **Phase 2** |
| **Agent registry** (1 cmd) | A (HTTP route) | Trivial | None — server fetches registry JSON | **Phase 2** |
| **ACP registry snapshot** (1 cmd) | A (HTTP route) | Trivial | Already an OS-fulfilled cap; just expose the result | **Phase 2** |
| **ACP binary install** (1 cmd) | A (HTTP route, long-running) | Low | Binary installed on SERVER filesystem, not browser; web client polls for completion | **Phase 2** |
| **Frontend error forwarding** (1 cmd) | A (POST route) | Trivial | None | **Phase 2** |
| **SSH profiles** (4 cmds) | A (file-backed store) | Low | Per-user keychain namespace on shared VPS | Phase 3 |
| **SSH connections + SFTP** (15 cmds) | B (event sink) + C (interactive WS) | Medium | Interactive SSH terminal = new WS spawn type; SFTP progress = WS events; credentials never leave server keychain | Phase 3 |
| **SSH port forwarding** (2 cmds) | B (event sink) | Low | Forward runs on server, not browser; web client only sees status | Phase 3 |
| **Secure storage** (3 cmds) | A (server-side vault) | Medium | Secrets live in SERVER keychain; web client never sees raw secret; per-user namespace on shared VPS | Phase 3 |
| **Data migration** (6 cmds) | A (file-backed store) | Low | Server store ≠ desktop store; migrations run against server's own store | Phase 3 |
| **File watching** (desktop: chokidar) | C (WS push, new) | Medium | High-frequency changes need debounce + gitignore-aware filtering; new server→client event push pattern | Phase 4 |
| **Attachment binary read** (1 cmd) | A (GET route, byte stream) | Low | Large files need streaming response; project-root boundary enforced | Phase 2 |
| **Log export** (4 cmds) | A (GET route) | Low | Logs live on server; web client downloads via HTTP | Phase 3 |
| **Browser tabs + annotations** (20 cmds) | D (headless browser) | **HIGH** | Needs `chromiumoxide`/`headless-chrome` crate; annotation overlay JS must switch from Tauri-invoke to WS; screenshot streaming is bandwidth-heavy; headless Chrome must be installed on server | Phase 5 (optional) |
| **Window/menu/tray** | N/A | Impossible | OS chrome — no browser equivalent | Never |
| **Remote server control** | N/A | N/A | Desktop IS the host; standalone server doesn't need self-control | Never |

### 7.5 Edge cases — deep dive

#### Edge 1: SSH interactive terminal sessions

The web client creates an SSH terminal tab. The server creates an `ssh2::Session`, opens a channel, and relays I/O:

```
POST /ssh/connect → { profileId } → { connectionId, terminalId }
WS  /terminal/ws  → { type: "attach", terminalId } → server pipes SSH channel I/O
```

**Edge cases:**
- **Lifecycle mismatch:** local PTYs die when killed; SSH sessions have reconnect/heartbeat logic (`HEARTBEAT_INTERVAL_SECS=15`, `MAX_RECONNECT_ATTEMPTS=5`, exponential backoff). The WS relay must handle reconnection without losing the session.
- **Known hosts:** `known_hosts` verification runs on the server — the web client never sees host keys. A first-connect "trust this host?" prompt must be relayed as a WS question (reuse the `QuestionRendezvous` pattern).
- **Askpass:** `ssh_create_askpass` creates a helper script that calls back to the app for passwords. On the server, this becomes a WS permission/question request — the web client responds via `/ws` `respond_permission`/`answer_question`.
- **Terminal type/size:** SSH PTY resize (`terminal_resize`) must propagate to the SSH channel (`channel.request_pty_size(cols, rows)`).

#### Edge 2: Headless browser for annotations (Pattern D)

The desktop's `BrowserTabManager` creates Tauri child webviews and injects `annotation-overlay.js` which uses `window.__TAURI_INTERNALS__.invoke` to report captures back. On the server:

```
POST /browser/tab/create → { url } → { tabId }
Server: chromiumoxide launches headless Chrome tab
  → injects MODIFIED annotation-overlay.js (WS-based, not Tauri-invoke)
  → polls URL/title/readyState (same poller logic, different transport)
WS  /browser/ws → { type: "subscribe", tabId } → server streams screenshots + annotation events
```

**Edge cases:**
- **Screenshot streaming:** `chromiumoxide` can capture screenshots as PNG bytes. Bandwidth: a 1920×1080 screenshot is ~200KB-2MB. Needs JPEG compression + diff-based streaming (only send changed regions) or DOM-level relay instead of pixel screenshots.
- **Annotation overlay rewrites:** `annotation-overlay.js` (in `src-tauri/resources/`) calls `__TAURI_INTERNALS__.invoke('browser_tab_report_region_captured', ...)`. In headless mode, this becomes a WS message. The overlay script needs a transport abstraction: `reportCapture(data)` → Tauri-invoke (desktop) or WS-send (server).
- **Interactive annotation:** the desktop overlay is interactive (click to select DOM elements). In headless mode, the web client clicks on a screenshot → server maps the click coordinates to DOM elements via CDP → highlights + captures. This is a different interaction model (screenshot + coordinate mapping vs. live DOM).
- **Headless Chrome dependency:** the server needs Chrome/Chromium installed. Add a startup check (like the keychain self-test in `lib.rs:1112-1118`).
- **Multiple tabs:** `chromiumoxide` supports multiple pages in one browser instance. Each browser tab = one `chromiumoxide` page.

#### Edge 3: Server-side keychain (secure storage)

The web client saves an SSH profile with a password. The password goes to the server's keychain:

```
POST /ssh/profiles          → { profile (no password in body) }
POST /ssh/credentials/store → { profileId, secret } → server stores in keychain
```

**Edge cases:**
- **Secret never in browser:** the web client sends the password once (over TLS, Phase 5), the server stores it in keychain, and the browser never sees it again. Subsequent connections retrieve it server-side.
- **Per-user namespace on shared VPS:** `credential_store.rs` uses `SERVICE_NAME = "termul-ssh"`. On a shared server with multiple users, this collides. Need a per-user service name: `format!("termul-ssh-{}", user_id)` or a server-side vault with its own auth.
- **Keyring availability:** the server might run headless (no D-Bus/Secret Service on Linux). `keyring` crate has a mock fallback — but that's insecure. For headless Linux servers, consider a file-encrypted vault (e.g., `age`-encrypted JSON) as a fallback when no OS keychain is available.

#### Edge 4: File watching over WS (new server→client push)

The desktop uses `chokidar` (Node) / the renderer directly watches files. On the server:

```
WS /fs/watch → { type: "subscribe", path } → server starts notify::Watcher
  → pushes { type: "fs_event", path, event_type } on change
  → { type: "unsubscribe", path } stops watching
```

**Edge cases:**
- **Debounce + gitignore:** `node_modules` changes during install = thousands of events/second. Server must debounce (e.g., 300ms) and respect `.gitignore` (reuse `worktree_parse_gitignore` logic).
- **Watcher limits:** Linux `inotify` has per-user limits (`fs.inotify.max_user_watches`). Large monorepos may exhaust them. Server should fall back to polling.
- **New event direction:** current WS events are server→client for terminal/ACP output. File-watch adds a new server→client push category. The `WsRelaySink` tier system (`Lossy`/`Reliable`/`Idempotent`) applies: file events should be `Lossy` (drop-oldest on slow client).

#### Edge 5: Streaming search (Pattern C)

```
WS /search/ws → { type: "content_search", cwd, pattern, opts }
  → server spawns ripgrep subprocess
  → streams { type: "search_result", file, line, content } frames
  → { type: "search_done" } or { type: "search_cancel" }
```

**Edge cases:**
- **Backpressure:** a monorepo search can produce 100k+ matches. The `WsRelaySink` `Lossy` tier (drop-oldest) handles this — the client gets the latest results, not all of them. Or paginate: client requests "next 100" via `getMore` WS message.
- **Cancellation:** `search_content_cancel` maps to a WS `cancel` message. The server kills the ripgrep subprocess. Follow the `terminal_kill` pattern.
- **Binary files:** ripgrep skips them by default; the server should not try to read/relay binary matches.

### 7.6 Extraction plan — decoupling managers from `AppHandle`

To make SSH/Migration managers work on the standalone server:

**Step 1: Introduce trait seams** (new files in `ssh/`):

```rust
// ssh/event_sink.rs (new)
pub trait SshEventSink: Send + Sync {
    fn emit_connection_status(&self, info: &SSHConnectionInfo);
    fn emit_sftp_progress(&self, op: &str, profile_id: &str, transferred: u64, total: u64);
    fn emit_port_forward_event(&self, forward_id: &str, status: &str);
}

// ssh/profile_store.rs (new)
pub trait ProfileStore: Send + Sync {
    fn list(&self) -> Result<Vec<SSHProfile>, String>;
    fn get(&self, id: &str) -> Result<Option<SSHProfile>, String>;
    fn save(&self, profile: &SSHProfile) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}
```

**Step 2: Implement both backends:**
- `TauriSshEventSink(AppHandle)` — wraps `app_handle.emit()` (desktop)
- `WsSshEventSink(Arc<WsRelaySink>)` — wraps `ws_relay.emit()` (server)
- `TauriProfileStore(AppHandle)` — wraps `app_handle.store()` (desktop)
- `FileProfileStore(PathBuf)` — file-backed JSON (server, like `FileProjectRegistry`)

**Step 3: Change `SSHManager::new` signature:**
```rust
// Before:
pub fn new(app_handle: tauri::AppHandle) -> Self
// After:
pub fn new(sink: Arc<dyn SshEventSink>, store: Arc<dyn ProfileStore>) -> Self
```

**Step 4: Wire both binaries:**
- `lib.rs` (desktop setup): `SSHManager::new(Arc::new(TauriSshEventSink(handle)), Arc::new(TauriProfileStore::new(handle)))`
- `server_main.rs` (standalone): `SSHManager::new(Arc::new(WsSshEventSink::new(ws_relay)), Arc::new(FileProfileStore::new(cfg.profiles_file)))`

**Step 5: Add web routes** in `web/ssh_api.rs` (new):
- `GET /ssh/profiles` → `ProfileStore::list`
- `POST /ssh/profiles` → `ProfileStore::save`
- `DELETE /ssh/profiles/:id` → `ProfileStore::delete`
- `POST /ssh/connect` → `SSHConnectionManager::connect` (returns connectionId)
- `POST /ssh/disconnect` → `SSHConnectionManager::disconnect`
- `GET /ssh/connections` → list active connections
- `POST /sftp/list` → `sftp::list_dir`
- etc. (19 routes total)

**Step 6: Extend `/terminal/ws`** (or new `/ssh/ws`) for interactive SSH terminal I/O.

**Step 7: Renderer facade** — `ssh-api.ts` currently early-returns on `!isTauriContext()`. Add `webServerSsh` methods calling the new routes.

**MigrationManager** follows the same pattern (swap `tauri-plugin-store` → `FileMigrationStore`).

### 7.7 What's already bridged (proof of concept)

| Feature | Desktop | Server (standalone) | Web client |
| --- | --- | --- | --- |
| ACP agents | `AcpManager` + `TauriEventSink` | `AcpManager` + `WsRelaySink` | `/ws` relay ✅ |
| Terminals | `PtyManager` + `TerminalEventHub::tauri()` | `PtyManager` + `TerminalEventHub::standalone()` | `/terminal/ws` ✅ |
| Chat history | `ChatHistoryStore` (app-data dir) | `SessionPersistence` (sessions dir) | `/ws` list/open/payload ✅ |
| Project registry | `ProjectRegistry` (renderer-fed) | `ProjectRegistry` + `FileProjectRegistry` (file-fed) | `/projects` ✅ |
| Permissions | `acp_respond_permission` command | `PermissionRendezvous` + `/ws respond_permission` | `/ws` ✅ |
| Questions | `acp_answer_question` command | `QuestionRendezvous` + `/ws answer_question` | `/ws` ✅ |

**The bridge pattern is proven.** ACP/PTY/ChatHistory/Permissions/Questions all use exactly the trait-swap + WS-relay pattern described above. SSH, migration, and search would follow the same template.

---

## 8. Graph-Validated Blast Radius (codebase-memory MCP)

Source: 11,453 nodes / 37,759 edges, queried via Cypher + trace_path.

### 8.1 Facade boundary is fully enforced

Query: `MATCH (caller:Function)-[:CALLS]->(callee:Function) WHERE callee.name = 'invoke' AND caller.file_path CONTAINS 'src/renderer/components/'`
**Result: 0 rows.** No renderer component/hook calls `invoke` directly — Biome's `noRestrictedImports` rule is 100% effective. All Tauri access is isolated in `src/renderer/lib/*-api.ts`. **Implication:** parity work is concentrated entirely in the facade layer; zero component or store changes needed for web git/search/skills routes.

### 8.2 Git facade blast radius (Phase 1 — exact)

`GitPanel` → `git-status-store` (Zustand) → `git-api.ts` (facade) → `invoke` / `webServerGit`. Trace depth 2.

| Consumer | File | Methods called |
| --- | --- | --- |
| `git-status-store.ts` | `src/renderer/stores/git-status-store.ts` | 17 (getStatus, getDiff, stage, unstage, discard, commit, push, getCommitContext, stashList, stashSave, stashApply, stashPop, stashDrop, branchList, branchSwitch, branchCreate) |
| `git-history-store.ts` | `src/renderer/stores/git-history-store.ts` | 1 (getLog) |
| `GitBranchPicker.tsx` | `src/renderer/components/GitBranchPicker.tsx` | 2 (checkoutBranch, createBranch) |
| `lib.rs` + `server_main.rs` | `src-tauri/src/` | 1 (init — already has web route) |

**Extension pattern** (template from `git-api.ts:34-35`):
```ts
// Existing (the only web-parity method):
init: (cwd: string) =>
  isTauriContext() ? invoke<void>('git_init', { cwd }) : webServerGit.init(cwd),

// Replicate for 19 more, e.g.:
getStatus: (cwd: string) =>
  isTauriContext()
    ? invoke<GitStatusDetail[]>('git_get_status', { cwd })
    : webServerGit.getStatus(cwd),
```

### 8.3 Other facade blast radii

| Facade | External consumers | Web fallback? | Priority |
| --- | --- | --- | --- |
| `ssh-api.ts` | 1 (`use-ssh-connection.ts`) — all 19 methods route through internal `invokeIpc` | ❌ None | Low (deferred) |
| `worktree-api.ts` | **1** (`GitBranchPicker.tsx` calls `branches` only) | ❌ None | Lowest (barely wired — only 1/13 methods consumed) |
| `skills-api.ts` | 1 (`use-agent-skills.ts` — listSkills, readSkill) | ❌ Returns `[]` on web | Trivial (2 routes + 2 branches) |

### 8.4 Web module complexity (code I'd extend)

Query: functions in `src-tauri/src/web/` ranked by cyclomatic complexity.

| Function | Cyclo | Cognitive | Lines | Notes |
| --- | --- | --- | --- | --- |
| `delete` | 12 | 20 | 31 | Most complex existing handler |
| `rename` | 11 | 18 | 30 | |
| `copy` | 11 | 18 | 30 | |
| `read` | 10 | 15 | 62 | |
| `mkdir` | 8 | 13 | 24 | Template for new git routes |
| `write` | 8 | 13 | 25 | Template for new git routes |
| `git_init` | 5 | 8 | 26 | Closest existing git route — copy this pattern |
| `resolve_request_path` | 6 | 12 | 95 | The `check_within_root` boundary — reuse for all new routes |

All manageable. New git route handlers will follow the `git_init`/`mkdir` pattern (complexity ~5-8). The `resolve_request_path` boundary checker (95 lines, already well-factored) is reused as-is.

### 8.5 Hotspots (fan-in) at the contract boundary

| Node | Fan-in | Role |
| --- | --- | --- |
| `IpcResult.success` | 100 | Desktop command result constructor |
| `IpcBody.ok` | 69 | Web route result constructor |
| `cn` | 222 | className util (UI-only, not parity-relevant) |

The `IpcResult.success` / `IpcBody.ok` pair confirms the dual-contract seam: desktop commands return `IpcResult`, web routes return `IpcBody` — both serialize to the same `{ success: true, data: T }` JSON. New routes must use `IpcBody::ok(data)` / `IpcBody::error(code, msg)` to match.

---

## 9. Out of Scope (not bridgeable)

- **OS chrome** — native menu (`suspend/restore_app_menu`), window controls (show/minimize/maximize/fullscreen/zoom), system tray, single-instance plugin. These are desktop OS integrations with no browser equivalent. Correctly desktop-only.
- **Remote server host control** (`remote_server_start/stop/status`) — the desktop IS the server host; the standalone server doesn't need self-control. Correctly desktop-only.
- **Native mobile (iOS/Android)** — no native target scaffolded (`gen/android`, `gen/ios` absent); mobile = responsive web only.

### 9.1 Bridgeable but deferred (see Section 7 for bridge patterns)

- **Browser tabs + annotations** (20 commands) — Pattern D (headless browser via `chromiumoxide`). HIGH cost, new subsystem, new dependency. Deferred to Phase 5 (optional). The annotation overlay JS needs transport abstraction (Tauri-invoke → WS).
- **Git worktrees** (13 commands) — Pattern A (HTTP routes). Low cost, but only 1/13 methods is actually consumed by the renderer (`GitBranchPicker` calls `branches`). Barely wired — deprioritize until the worktree UI is built out.
- **SSH/SFTP** (19 commands) — Patterns A+B+C (storage swap + event sink swap + interactive WS). Medium cost, HIGH feasibility (see Section 7.2). Scheduled as **Phase 3**.
- **Secure storage** (3 commands) — Pattern A (server-side keychain vault). Medium cost (per-user namespace, headless Linux fallback). Scheduled as **Phase 3**.
- **Data migration** (6 commands) — Pattern A (file-backed store swap). Low cost. Scheduled as **Phase 3**.
- **File watching** — Pattern C (new server→client WS push). Medium cost (debounce, gitignore, inotify limits). Scheduled as **Phase 4**.
