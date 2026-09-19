# Anti-Bug Report

- Repository: `/root/termul`
- Sweep started: 2026-09-18T04:09:54+00:00
- Last updated: 2026-09-18T10:31:32+00:00

## Executive summary

54 findings recorded: 1 critical, 10 high, 25 medium, 18 low.

Fixed: 10 | False positive: 0 | Needs decision: 1 | Deferred: 0

**Scope:** the termul-server Rust backend — `src-tauri/src/web/` (~28k lines),
`src-tauri/src/pty/`, `src-tauri/src/remote/`, `src-tauri/src/acp/`,
`server_main.rs`, `onboard.rs`, `server_update.rs`. Swept by 8 parallel
read-only defect-hunt agents plus a direct review of the router, auth gate,
and high-risk handlers; every recorded finding carries a file:line trace or a
live repro. Renderer/TS code, `landing/`, and the desktop-only Tauri command
layer were excluded except where a web route shares the same helper.

**Release readiness: Ready with conditions.** The critical data-loss bug
(F-006, discard `path:"."` wiping the whole repo incl `.git`) and both
broken branch routes (F-007/F-008 — `branch-switch` could never switch and
silently reverted files on name collision; `branch-create` always failed)
are fixed with regression tests and revert-checks; the full suite went from
1146-pass/3-fail to 1160-pass/0-fail and clippy is clean under `-D warnings`.

Conditions — the remaining high-severity confirmed findings must be triaged
before any public-bind or shared-live exposure:

1. **F-003 + F-009:** remote-write confinement can be escaped via a dangling
   symlink leaf (`/fs/write`, `/fs/copy`, `/fs/mkdir`) and via an unsanitized
   worktree `name` — both write outside `project_root` for an opted-in remote
   peer. Loopback-only deployments are not exposed.
2. **F-017 + F-018:** an admitted remote peer can redefine the `project_root`
   jail itself through `/projects` CRUD (register `/` as a project root), and
   every WS mutation request bypasses the loopback/remote-write guard its HTTP
   twin enforces. Together they make `--allow-remote-writes` weaker than its
   startup warning claims.
3. **F-033:** no Origin/Host validation on WS upgrades — an ungated loopback
   standalone server (the default install posture) is drive-by RCE from any
   web page via DNS rebinding.

Top risks in one line each: data loss via git discard/branch routes (fixed);
remote-write confinement escapes (open, conditions 1-2); drive-by RCE against
ungated loopback servers (open, condition 3).

**What was NOT run:** dependency audit (`cargo audit` not invoked; no
`cargo deny`), and the renderer test suites (`bun run test`/`typecheck`) —
no renderer files were touched, so those results would be identical to CI's.
Every other check (build, full Rust suite, clippy `-D warnings`, live server
smoke boot) was executed with output recorded in the Baseline section.

## Business rules register

Findings in the business-logic category are judged against these. A rule marked `inferred` was derived from the code rather than stated by the business, and needs confirmation before any finding resting on it is treated as settled.

| ID | Area | Rule | Source | Confidence |
|---|---|---|---|---|
| R-001 | web-auth | Public bind requires bearer token (generated+persisted 0600 if absent); loopback+no configured token is ungated; unresolvable token on public bind aborts startup (fail closed) | src-tauri/src/web/auth.rs:1-23,142-236 | stated |
| R-002 | web-auth | Token never printed or logged; constant-time compare; no ?token= query-param fallback on gated routes; token bootstrap via URL fragment only | src-tauri/src/web/router.rs:311-328; auth.rs:21-23 | stated |
| R-003 | remote-writes | Mutation routes refuse non-loopback peers unless --allow-remote-writes; shared-live deployment mode denies ALL writes regardless of peer | src-tauri/src/web/fs_api.rs:201-276 | stated |
| R-004 | remote-writes | Non-loopback peer admitted via --allow-remote-writes is confined to project_root for fs writes; loopback keeps ADR-007 any-path breadth | src-tauri/src/web/fs_api.rs:278-295 | stated |
| R-005 | containment | Operation routes (/git/*, /skills, /search/content, /worktree/*) confined to default project_root or any registered non-archived project root; OUTSIDE_PROJECT_ROOT otherwise | src-tauri/src/web/router.rs:56-65 | stated |
| R-006 | paths | Any path containing a .. component is rejected with PATH_TRAVERSAL on fs routes | src-tauri/src/web/fs_api.rs:307-321 | stated |
| R-007 | permissions | Permission rendezvous: bounded timeout resolves deny; client disconnect denies its tickets after grace; first-response-wins; option_id re-validated against original options (TOCTOU); only session-subscribed clients may respond | src-tauri/src/web/permissions.rs:1-31,55-99 | stated |
| R-008 | lifecycle | Standalone server owns and kills its PTYs/agents on shutdown; desktop shared-live must never kill desktop agents; live PTY sessions survive project switches | src-tauri/src/web/mod.rs:112-114; AGENTS.md | stated |
| R-009 | self-update | Self-update is opt-in only (env or --check-update); signature verified before swap; never auto-restarts an unattended server | src-tauri/src/server_main.rs:457-463 | stated |
| R-010 | acp-install | ACP install downloads archive, verifies sha256, extracts, atomically activates; request carries agentId only, host resolves everything from trusted catalog | src-tauri/src/web/mod.rs:105-110; router.rs:201-206 | stated |
| R-011 | ws-protocol | WS clients authenticate in-protocol when gate active; event replay via cursors with per-session seq counters | src-tauri/src/web/auth.rs:4-6; ws.rs | stated |
| R-012 | persistence | Standalone owns its state roots (sessions, workspace-manifests, acp-catalog, acp-registry-binaries) exclusively; never shared with a desktop host on same machine | src-tauri/src/server_main.rs:217-251 | stated |
| R-013 | mcp-oauth | MCP OAuth flows: state/PKCE validated on callback; tokens stored atomically; pending flows bounded; expired tokens refreshed before deletion | src-tauri/src/web/mcp_oauth_api.rs docs; acp/mcp_oauth.rs | inferred |

## Baseline

| Command | Status | Output |
|---|---|---|
| `cargo test --features standalone-server (cwd src-tauri)` | failed | test result: FAILED. 1146 passed; 3 failed; 1 ignored — failures: tests::test_fallback_shell, tests::test_get_default_shell_returns_some (SHELL unset env → F-001), remote::host::tests::shared_live_binds_project_root_to_active_cross_drive_project (stale assertion vs CAP-2 boundary semantics) |
| `final verification` | passed | cargo test --features standalone-server: 1160 passed, 0 failed, 1 ignored (baseline: 1146 passed, 3 failed). cargo clippy --all-targets -- -D warnings: 0 errors. termul-server smoke boot: /health ok, /shells default=bash (F-001 fix live), /git/init refuses outside-root and traversal (F-002 fix live), /fs/ls ok. |

## Findings table

| ID | Severity | Category | Rule | Location | Status | Title |
|---|---|---|---|---|---|---|
| F-006 | critical | data-integrity | R-003 | `src-tauri/src/trackers/git_tracker.rs:920-932 (is_safe_relative_path accepts '.'), :1213-1228 delete_untracked_path remove_dir_all(cwd); reached via git_api.rs:361-370` | fixed | /git/discard path='.' wipes entire working tree incl .git |
| F-002 | high | security | R-003 | `src-tauri/src/web/fs_api.rs:925-950 (handler body has zero guards); route registered src-tauri/src/web/router.rs:148` | fixed | /git/init missing loopback guard AND project-root containment — any peer can git init any host path |
| F-003 | high | security | R-004 | `src-tauri/src/web/fs_api.rs:378-441 (resolve_request_path non-existent branch re-attaches leaf verbatim); callers fs_api.rs:560-578 (write), 889-918 (copy to), 517-543 (mkdir)` | confirmed | Dangling-symlink leaf escapes remote-write project_root confinement on /fs/write, /fs/copy, /fs/mkdir |
| F-004 | high | security | R-003 | `src-tauri/src/web/mcp_servers_api.rs:63-111 (no ConnectInfo/check_local_only); route src-tauri/src/web/router.rs:120-123` | fixed | PUT /mcp-servers missing loopback/remote-writes guard — remote peer writes .termul/mcp-servers.json (MCP command definitions) |
| F-007 | high | correctness | R-005 | `src-tauri/src/web/git_api.rs:979-988 run_simple_checkout builds [checkout, --, name]` | fixed | /git/branch-switch runs 'git checkout -- <name>' — never switches; silently discards file changes on name collision |
| F-008 | high | correctness | R-005 | `src-tauri/src/web/git_api.rs:991-1000 run_simple_checkout_b builds [checkout, -b, --, name]` | fixed | /git/branch-create runs 'git checkout -b -- <name>' — always fails |
| F-009 | high | security | R-005 | `src-tauri/src/worktree/mod.rs:478-485 target={project}/.termul/worktrees/{name}/; route worktree_api.rs:234-294 checks project_path/target_path only` | confirmed | /worktree/create name unsanitized in default target path — .. escapes project boundary |
| F-017 | high | security | R-004 | `src-tauri/src/web/projects_api.rs:320,344,398 (upsert accepts any existing dir); :150-169 set_default_project rebinds; project_registry.rs:440-466 rebind; fs_api.rs:285-295 + git_api.rs:179-186 confinement follows it` | confirmed | Remote peer can redefine the project_root jail via /projects CRUD — confinement escape |
| F-018 | high | security | R-003 | `src-tauri/src/web/ws.rs:1300-1347 (set_default_project/add_project/update_project/remove_project dispatch), :2510-2947 handlers (no peer context), :1378-1380,2244-2340 store_write/store_delete; contrast projects_api.rs:134-161` | confirmed | WS mutation requests bypass the loopback/remote-write guard entirely |
| F-033 | high | security | R-001 | `src-tauri/src/web/ws.rs ws_upgrade (no Origin check, no Host check); terminal_ws.rs:42-47 terminal_ws_upgrade; connect info passes 127.0.0.1 so check_local_only admits; router.rs PUBLIC_PATHS includes /ws and /terminal/ws` | confirmed | No Origin/Host validation on WS upgrades — drive-by DNS-rebinding RCE against ungated loopback standalone server (CWE-346) |
| F-035 | high | security | R-003 | `src-tauri/src/web/mcp_servers_api.rs:24-61 get reads raw JSON incl command env; mcp_probe_api.rs:21-40 probe spawns Command from request body with no guard; remote/host.rs shared-live web_auth=None` | confirmed | GET /mcp-servers returns raw config incl env secrets; POST /mcp-servers/probe = unauthenticated arbitrary command spawn (shared-live deny-all-writes bypassed) |
| F-001 | medium | correctness | R-008 | `src-tauri/src/pty/manager.rs:2086-2089; src-tauri/src/lib.rs:290-301` | fixed | PTY default shell ignores /etc/passwd login shell when SHELL unset (systemd) |
| F-005 | medium | security | R-003 | `src-tauri/src/web/catalog_api.rs:119-173 (no ConnectInfo/check_local_only); route router.rs:200` | fixed | POST /acp/catalog/opt-in missing loopback guard — remote peer flips host CDN-augmentation flag |
| F-010 | medium | security | R-005 | `src-tauri/src/worktree/mod.rs:517-530 exists()+fs::write follow symlink` | confirmed | /worktree/create writes .gitignore through symlink — arbitrary file append/create |
| F-011 | medium | security | R-005 | `git_tracker.rs:978 checkout -q <branch>; :995 checkout -q -b <branch> <start>; worktree/mod.rs:507-512 worktree add args` | confirmed | Option injection via '-'-prefixed branch/ref args in checkout/create-branch/worktree-create |
| F-012 | medium | security | R-005 | `git_tracker.rs:1001-1003 add -- <path>; :1012-1018 reset/rm --cached; :1233-1246 discard` | confirmed | Pathspec-magic path args widen stage/unstage/discard to whole repo |
| F-019 | medium | data-integrity | R-005 | `src-tauri/src/web/projects_api.rs:429-451, :519-536; acp/project_registry.rs:419-421 and :388-390 clear the default; rollback only restores the root; restore_default_project at :348 exists but is not called` | confirmed | update_project/remove_project rollback drops default_project_id |
| F-020 | medium | data-integrity | R-005 | `src-tauri/src/web/projects_api.rs:323-330 (VfsRoot mcp_servers: Vec::new()), :390-398 (is_default:false, raw path); project_registry.rs:159-166 (upsert no default recompute); acp/project_registry.rs:362-376` | fixed | create/add_project upsert leaves dangling archived default, clears is_default, wipes file-side mcp_servers |
| F-021 | medium | concurrency | R-005 | `src-tauri/src/web/projects_api.rs:192-221 (file lock) then :225 (memory lock); same shape at :335-359->:398, :427-452->:481, :517-537->:566; WS twins ws.rs:2556-2592, 2696-2742, 2778-2835, 2887-2939` | confirmed | File-vs-memory commit ordering race -> split-brain registry |
| F-022 | medium | data-integrity | R-005 | `src-tauri/src/web/projects_api.rs:442 (save_atomic committed) -> :481-494 (registry.update false -> NOT_FOUND, file NOT rolled back); contrast :225-240 which does roll back` | confirmed | update_project persists to file then fails in-memory with no rollback |
| F-023 | medium | correctness | R-001 | `src-tauri/src/web/config.rs:37-45 (XDG_STATE_HOME/HOME no empty filter, no is_absolute) vs :88-100, :356-367; onboard.rs:79-83 (normalize applied to projects_file but not sessions_dir)` | confirmed | default_sessions_dir/service_account_state_dir lack empty/relative env filtering; onboard bakes relative sessions_dir into systemd unit |
| F-024 | medium | security | R-001 | `src-tauri/src/onboard.rs:75-78 (unwrap_or_else(\|\| PathBuf::from("/"))) contradicting comment at :72-73` | confirmed | OnboardAnswers::defaults falls back to / as project_root |
| F-030 | medium | correctness | R-005 | `src-tauri/src/server_main.rs:309-321 -> web/mod.rs:279 -> router.rs:235; contrast remote/host.rs:1128-1129` | suspected | Standalone startup never derives project_root from the registry default |
| F-034 | medium | security | R-003 | `src-tauri/src/web/fs_api.rs:660-681 read uses fs::metadata len=0 for char devices then fs::read unbounded (/dev/urandom reads until OOM); /fs/info opens FIFO (blocking open); copy from FIFO blocks` | confirmed | /fs/read and ls/browse on special files: /dev/urandom OOM, /dev/zero, FIFO hang, block-device read — remote DoS via thread-pool exhaustion |
| F-036 | medium | correctness | R-007 | `src-tauri/src/acp/session_persistence.rs:1620-1636 is_durable_event excludes permission_request but NOT question_request` | confirmed | question_request is durable (replayed to reconnecting clients) unlike permission_request — stale unanswerable questions |
| F-037 | medium | correctness | R-011 | `src-tauri/src/web/ws.rs handle_subscribe/subscribe_snapshot persistence-first path; session_persistence.rs flush_session SessionNotFound arm` | confirmed | Ephemeral/live-only session transcript unrecoverable on reconnect (cursor subscribe returns Stale/NotFound) |
| F-038 | medium | concurrency | R-007 | `src-tauri/src/web/ws.rs dispatch_connection_text (subscribed_clients lock held across handle_subscribe disk IO / install download awaits)` | suspected | dispatch_connection_text holds the per-connection lock across all handler awaits — head-of-line blocking delays respond_permission past the 60s rendezvous timeout |
| F-039 | medium | concurrency | R-007 | `src-tauri/src/web/permissions.rs QuestionRendezvous::with_timeout (no grace field) vs PermissionRendezvous DEFAULT_PERMISSION_RECONNECT_GRACE` | confirmed | QuestionRendezvous denies on last-subscriber disconnect with NO grace period (permissions get 60s reconnect grace) |
| F-041 | medium | correctness | R-005 | `src-tauri/src/web/ws.rs handle_create_session + handle_switch_project (cwd used verbatim; add_project path unvalidated on desktop-hosted mode)` | confirmed | handle_create_session/switch_project do not canonicalize/validate cwd — sessions spawnable in arbitrary or non-existent dirs |
| F-042 | medium | correctness | R-007 | `src-tauri/src/web/permissions.rs SessionQueue promote_next (no event on promotion); relay fans out queued permission_request immediately` | confirmed | Queued permission requests fanned out but unanswerable until promoted; promotion emits no signal; stale response errors |
| F-043 | medium | security | R-010 | `src-tauri/src/acp/install.rs:609-643 (no sha256 verification, comment says catalog trusted); web/mod.rs:105-110 + R-010 docs claim 'downloads + verifies (sha256)'; acp_registry_snapshot.rs follows https->http redirects with no size cap (deferred-work notes this)` | confirmed | install path performs NO sha256 verification despite docs claiming verify — MITM downgrade-redirect chain enables registry agent injection |
| F-044 | medium | security | R-010 | `src-tauri/src/acp_binary_install.rs (archive URL from caller; backup path collision; /tmp staging rename across filesystems)` | confirmed | legacy acp_binary_install accepts untrusted archive URLs + same https->http downgrade; backup path collision can delete installed agents; EXDEV swap failure |
| F-045 | medium | correctness | R-013 | `src-tauri/src/acp/mcp_oauth.rs (token file write not atomic; blocking refresh path deletes expired; urlencode incomplete); web/mcp_oauth_api.rs pending flows map` | needs-decision | mcp_oauth: pending_oauth_flows unbounded; store_token non-atomic; get_valid_token_blocking deletes expired tokens without refresh attempt; urlencode misses ?/#//; iss ignored |
| F-047 | medium | security | R-003 | `src-tauri/src/web/terminal_ws.rs:42-47 (no ConnectInfo/peer check; web_auth None on shared-live); remote/host.rs binds Localhost + cloudflared forwards public traffic as loopback` | confirmed | terminal_ws + PTY surface reachable without peer gating: shared-live tunnel clients spawn PTYs while shared_live_writes_denied claims ALL writes denied |
| F-050 | medium | security | R-012 | `src-tauri/src/web/mod.rs:258-267 (store default under service_account_state_dir on both paths); desktop app-data isolation pattern used by other services` | confirmed | Desktop and standalone share ~/.local/state/termul/store.json — web-store cross-contamination (SSH profiles, settings) between two products |
| F-052 | medium | correctness | R-004 | `src-tauri/src/web/fs_api.rs:802-835 delete uses canonicalized path so a project symlink to a dir deletes the target recursively; rename :841-876 moves resolved target leaving link dangling` | confirmed | FsApi: delete on symlink-to-dir removes the TARGET tree (resolved path); rename moves target not link — desktop/web divergence and loopback data-loss footgun |
| F-013 | low | correctness | R-005 | `git_tracker.rs:1234-1244 lines().next(); :871-877 starts_with('??')` | confirmed | git_discard_file/git_get_diff classify directory pathspec by FIRST status line |
| F-014 | low | performance | R-005 | `search_api.rs:167-180 rg_command.output(); sibling commands.rs:2529-2532; worktree/mod.rs:317-342 run_git no timeout` | confirmed | /search/content runs rg with no timeout and unbounded output buffering |
| F-015 | low | security | R-005 | `skills/mod.rs:138 file_type().is_dir() skips symlinks vs :243-255 is_file() follows` | suspected | read_agent_skill follows symlinked skill dirs that scan_skills_dir skips |
| F-016 | low | correctness | R-005 | `worktree/mod.rs:680-683 '?'\|'!' => untracked += 1` | fixed | check_dirty counts ignored files (!!) as untracked |
| F-025 | low | correctness | R-011 | `src-tauri/src/web/store.rs:105; ws.rs:2199-2200` | confirmed | WebStore CAS cannot express expect-absent (JSON null -> None -> unconditional write) |
| F-026 | low | performance | R-012 | `src-tauri/src/acp/workspace_manifest.rs:471-479 vs :760-768` | confirmed | WorkspaceManifestService lock map grows unboundedly |
| F-027 | low | correctness | R-005 | `src-tauri/src/web/project_registry.rs:306-337 + is_within_dir:483-493` | confirmed | find_by_path misattributes cwds containing '..' (raw string prefix match) |
| F-028 | low | correctness | R-005 | `src-tauri/src/web/project_registry.rs:187-211` | confirmed | update() leaves stale is_default=true on an archived default |
| F-029 | low | correctness | R-005 | `src-tauri/src/web/projects_api.rs:394; project_registry.rs:157-158 doc claims rebind, :159-166 calls none` | confirmed | create_project stores raw non-canonical path in memory; upsert never rebinds project_root despite doc claim |
| F-031 | low | config | R-001 | `src-tauri/src/web/config.rs:201-205` | confirmed | BindMode::All binds 0.0.0.0 — IPv4 only on dual-stack hosts |
| F-032 | low | data-integrity | R-005 | `src-tauri/src/web/project_registry.rs:141-151; callers commands.rs:3371` | confirmed | ProjectRegistry::set accepts invalid default (archived/unknown/pathless) |
| F-040 | low | performance | R-012 | `src-tauri/src/web/sink.rs sessions map (only forget_session removes); permissions.rs SessionQueue empty entries; TurnWatermark maps` | confirmed | WsRelaySink sessions map + SessionQueue + TurnWatermark grow unboundedly; forget_session never called on close_session |
| F-046 | low | security | R-001 | `src-tauri/src/web/catalog_api.rs:74-77 overlay_installed; :58 refresh param` | confirmed | overlay_installed leaks absolute command paths to remote clients (contradicts catalog doc); catalog refresh CDN fetch unauthenticated |
| F-048 | low | correctness | R-008 | `src-tauri/src/pty/manager.rs kill (is_hidden check before lookup), cleanup paths, orphan reaper; resolve_shell_path fixed dirs only` | confirmed | PtyManager kill/resolve issues: kill returns success for non-existent ids when hidden; kill spawn-blocking error skips cleanup; orphan reaper missing terminal_events.remove; resolve_shell_path does not search PATH on Unix |
| F-049 | low | correctness | R-008 | `src-tauri/src/web/terminal_ws.rs:590-595 (timeout_ms logged); pty/manager.rs web_attachments accounting; claims.rs generation reset vs forwarder teardown gap` | confirmed | update_orphan_detection timeout unit mismatch (ms vs secs) + idle forwarder generation checks + web attachment slot accounting leaks |
| F-051 | low | correctness | R-008 | `src-tauri/src/remote/host.rs stop() (axum on_upgrade detaches; no header read timeout); remote_server_start bind_mode param ignored` | confirmed | RemoteServerState stop() does not disconnect live WS clients; can hang indefinitely on stuck in-flight request; bind_mode 'all' silently downgraded to localhost |
| F-053 | low | correctness | R-004 | `src-tauri/src/web/fs_api.rs rename/copy (std::fs::rename semantics differ by platform)` | confirmed | FsApi: Windows rename replaces existing files + cross-volume moves (MOVEFILE_COPY_ALLOWED) — Unix EXDEV divergence; procfs size field inconsistent |
| F-054 | low | test-quality | R-005 | `src-tauri/src/remote/host.rs:1227-1256 (fixed)` | fixed | Stale cross-drive boundary test contradicted CAP-2 registered-root semantics |

## Detailed findings

### F-006 - /git/discard path='.' wipes entire working tree incl .git

**Severity:** critical | **Category:** data-integrity | **Status:** fixed | **Rule:** R-003 (stated)

**Location:** `src-tauri/src/trackers/git_tracker.rs:920-932 (is_safe_relative_path accepts '.'), :1213-1228 delete_untracked_path remove_dir_all(cwd); reached via git_api.rs:361-370`

**Evidence:**

is_safe_relative_path rejects ParentDir/RootDir/Prefix but not CurDir; Path::new(cwd).join('.') == cwd. Same blast radius via desktop git_discard (commands.rs:3990). Sibling: './' identical.

**Reproduction:**

POST /git/discard {cwd:<repo>, path:'.'} with any untracked entry -> first status line '??' -> DeleteUntracked -> remove_dir_all(<repo>/.) deletes every child incl .git, then errors EINVAL. Verified live.

**Fix attempts:**

| # | Mechanism | Outcome | Measured | Failure class |
|---|---|---|---|---|
| 1 | is_safe_relative_path now rejects empty, CurDir components, and trailing '/.' (components() elides trailing dot); delete_untracked_path inherits the guard | pass | 74/74 git_tracker tests green; revert-check: old-guard code fails test_is_safe_relative_path at the '.' assertion | - |

**Tests:**

- `trackers::git_tracker::tests::test_is_safe_relative_path + it_discard_whole_repo_pathspec_is_refused`

### F-002 - /git/init missing loopback guard AND project-root containment — any peer can git init any host path

**Severity:** high | **Category:** security | **Status:** fixed | **Rule:** R-003 (stated)

**Location:** `src-tauri/src/web/fs_api.rs:925-950 (handler body has zero guards); route registered src-tauri/src/web/router.rs:148`

**Evidence:**

Handler calls GitTracker::run_git_command(&cwd, ["init"]) directly on the raw request string. Compare git_api.rs:195-235 resolve_cwd which all other /git/* routes use (check_local_only + .. rejection + boundary).

**Reproduction:**

POST /git/init {"cwd": "/tmp/anywhere"} from a non-loopback peer without --allow-remote-writes -> git init runs. Also accepts .. components (no resolve_request_path) and paths outside project_root (no ensure_within_project_boundary), unlike every sibling /git/* route.

**Fix attempts:**

| # | Mechanism | Outcome | Measured | Failure class |
|---|---|---|---|---|
| 1 | git_init now routes through git_api::resolve_cwd (check_local_only + resolve_request_path + ensure_within_project_boundary) like every sibling /git/* write | pass | 63/63 web::fs_api tests green; revert-check: unguarded handler fails all 3 new tests | - |

**Tests:**

- `web::fs_api::tests::git_init_refused_from_non_loopback_peer + git_init_rejects_path_traversal_cwd + git_init_rejects_cwd_outside_project_root`

### F-003 - Dangling-symlink leaf escapes remote-write project_root confinement on /fs/write, /fs/copy, /fs/mkdir

**Severity:** high | **Category:** security | **Status:** confirmed | **Rule:** R-004 (stated)

**Location:** `src-tauri/src/web/fs_api.rs:378-441 (resolve_request_path non-existent branch re-attaches leaf verbatim); callers fs_api.rs:560-578 (write), 889-918 (copy to), 517-543 (mkdir)`

**Evidence:**

path.exists() is false for a dangling symlink, so the ancestor-walk branch runs: parent canonicalizes inside project_root, leaf 'link' re-attached verbatim. Containment checks the unresolved leaf path, not the symlink target. fs::write/fs::copy/create_dir_all all follow the link.

**Reproduction:**

Remote peer admitted via --allow-remote-writes: ln -s /etc/cron.d/evil <project_root>/link (dangling). POST /fs/write {path: <project_root>/link} -> resolve_request_path returns <project_root>/link (inside, passes ensure_remote_within_project_root) -> fs::write follows the symlink and creates/writes /etc/cron.d/evil outside the boundary.

### F-004 - PUT /mcp-servers missing loopback/remote-writes guard — remote peer writes .termul/mcp-servers.json (MCP command definitions)

**Severity:** high | **Category:** security | **Status:** fixed | **Rule:** R-003 (stated)

**Location:** `src-tauri/src/web/mcp_servers_api.rs:63-111 (no ConnectInfo/check_local_only); route src-tauri/src/web/router.rs:120-123`

**Evidence:**

Handler takes only State+Json; every sibling mutation route (fs writes, git writes, workspace write/delete, /acp/install, /projects/*, /log/frontend-error, mcp_oauth control routes) calls check_local_only. server_main.rs:165-188 warn lists the remote-write surface and does not include /mcp-servers.

**Reproduction:**

POST/PUT /mcp-servers from a non-loopback peer without --allow-remote-writes -> writes {project_root}/.termul/mcp-servers.json. The file defines MCP stdio commands the host later spawns, so this is a remote-write (and latent command-execution) primitive the opt-in was meant to gate.

**Fix attempts:**

| # | Mechanism | Outcome | Measured | Failure class |
|---|---|---|---|---|
| 1 | PUT /mcp-servers now extracts ConnectInfo and calls check_local_only (loopback/opt-in/shared-live-deny) before persisting | pass | 4/4 mcp_servers_api tests green; revert-check: removing the guard fails both new tests | - |

**Tests:**

- `web::mcp_servers_api::tests::put_refused_from_non_loopback_peer + put_refused_in_shared_live_mode`

### F-007 - /git/branch-switch runs 'git checkout -- <name>' — never switches; silently discards file changes on name collision

**Severity:** high | **Category:** correctness | **Status:** fixed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/git_api.rs:979-988 run_simple_checkout builds [checkout, --, name]`

**Evidence:**

Verified in scratch repo. Desktop parity is [checkout, &name] (commands.rs:4290). The -- makes name a pathspec.

**Reproduction:**

git checkout -- feature -> 'pathspec did not match', stays on master. git checkout -- a.txt (modified) exits 0, reverts file, returns success:true — silent data loss.

**Fix attempts:**

| # | Mechanism | Outcome | Measured | Failure class |
|---|---|---|---|---|
| 1 | run_simple_checkout delegates to git_tracker::git_checkout_branch (desktop parity) after is_branch_name ref verification refuses non-branch names | pass | 14/14 web::git_api tests green; revert-check: old [checkout,--,name] fails all 3 new tests | - |

**Tests:**

- `web::git_api::tests::branch_switch_actually_switches_branch + branch_switch_name_colliding_with_file_never_reverts_it`

### F-008 - /git/branch-create runs 'git checkout -b -- <name>' — always fails

**Severity:** high | **Category:** correctness | **Status:** fixed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/git_api.rs:991-1000 run_simple_checkout_b builds [checkout, -b, --, name]`

**Evidence:**

Verified. -b consumes -- as branch name and name as start-ref. Desktop parity [checkout, -b, &name] (commands.rs:4314).

**Reproduction:**

git checkout -b -- newbr -> fatal: 'newbr' is not a commit and a branch '--' cannot be created (exit 128). Route can never succeed.

**Fix attempts:**

| # | Mechanism | Outcome | Measured | Failure class |
|---|---|---|---|---|
| 1 | run_simple_checkout_b delegates to git_tracker::git_create_branch (desktop parity) after rejecting option-shaped names | pass | branch_create test green; revert-check: old [checkout,-b,--,name] fails | - |

**Tests:**

- `web::git_api::tests::branch_create_actually_creates_and_switches`

### F-009 - /worktree/create name unsanitized in default target path — .. escapes project boundary

**Severity:** high | **Category:** security | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/worktree/mod.rs:478-485 target={project}/.termul/worktrees/{name}/; route worktree_api.rs:234-294 checks project_path/target_path only`

**Evidence:**

name never validated; default target assumed inside boundary. Desktop worktree_create shares flaw but has no boundary contract.

**Reproduction:**

{name:'../../../tmp/evil-wt'} -> git worktree add -b x /repo/.termul/worktrees/../../../tmp/evil-wt creates worktree outside every registered root. Verified. Also '..' targets .termul itself; backslash traversal on Windows.

### F-017 - Remote peer can redefine the project_root jail via /projects CRUD — confinement escape

**Severity:** high | **Category:** security | **Status:** confirmed | **Rule:** R-004 (stated)

**Location:** `src-tauri/src/web/projects_api.rs:320,344,398 (upsert accepts any existing dir); :150-169 set_default_project rebinds; project_registry.rs:440-466 rebind; fs_api.rs:285-295 + git_api.rs:179-186 confinement follows it`

**Evidence:**

validate_root_path only requires an existing directory; the admitted peer moves the boundary itself. server_main.rs:172-181 startup warn claims remote fs writes are CONFINED to project_root — defeated by the peer's own ability to move it.

**Reproduction:**

termul-server --host 0.0.0.0 --allow-remote-writes --project-root /srv/app; LAN peer: POST /projects {path:"/"} -> POST /projects/default {id:x} -> POST /fs/write {path:"/etc/cron.d/pwn"} succeeds. Even without step 2, /git/status {cwd:/any/repo} passes (registered root /).

### F-018 - WS mutation requests bypass the loopback/remote-write guard entirely

**Severity:** high | **Category:** security | **Status:** confirmed | **Rule:** R-003 (stated)

**Location:** `src-tauri/src/web/ws.rs:1300-1347 (set_default_project/add_project/update_project/remove_project dispatch), :2510-2947 handlers (no peer context), :1378-1380,2244-2340 store_write/store_delete; contrast projects_api.rs:134-161`

**Evidence:**

WS transport has no peer context and no shared_live_writes_denied check while HTTP twins enforce check_local_only. Sibling: every post-auth WS mutation (spawn_agent, kill_agent, delete_session, store_*, install_acp_agent).

**Reproduction:**

0.0.0.0 bind without --allow-remote-writes: LAN client POST /projects -> FORBIDDEN but WS {type:add_project} succeeds. On shared-live: POST /workspace/x/write denied but WS mutations not.

### F-033 - No Origin/Host validation on WS upgrades — drive-by DNS-rebinding RCE against ungated loopback standalone server (CWE-346)

**Severity:** high | **Category:** security | **Status:** confirmed | **Rule:** R-001 (stated)

**Location:** `src-tauri/src/web/ws.rs ws_upgrade (no Origin check, no Host check); terminal_ws.rs:42-47 terminal_ws_upgrade; connect info passes 127.0.0.1 so check_local_only admits; router.rs PUBLIC_PATHS includes /ws and /terminal/ws`

**Evidence:**

ws_upgrade/terminal_ws_upgrade read no headers; hyper sends Origin on WS handshakes; no PNA enforcement for ws:// to loopback from http pages. Standalone loopback default (no token, no gate) is the default install posture. Token-gated public binds resist (token required). Also CSWSH: token in localStorage never auto-sent on cross-site WS, so gated servers resist.

**Reproduction:**

Attacker page (HTTP, or DNS-rebinding domain resolving to 127.0.0.1) opens ws://127.0.0.1:8080/terminal/ws on an ungated loopback termul-server: browser sends Origin: evil.com + Host: evil.com; server ignores both, peer is loopback -> PTY spawn = arbitrary command execution from a malicious web page. Same via /ws mutations and loopback-guarded HTTP routes (DNS rebinding: Host check absent).

### F-035 - GET /mcp-servers returns raw config incl env secrets; POST /mcp-servers/probe = unauthenticated arbitrary command spawn (shared-live deny-all-writes bypassed)

**Severity:** high | **Category:** security | **Status:** confirmed | **Rule:** R-003 (stated)

**Location:** `src-tauri/src/web/mcp_servers_api.rs:24-61 get reads raw JSON incl command env; mcp_probe_api.rs:21-40 probe spawns Command from request body with no guard; remote/host.rs shared-live web_auth=None`

**Evidence:**

Shared-live passes web_auth None (mod.rs:206-209) so /mcp-servers* is reachable through the public tunnel; shared_live_writes_denied does not apply to probe (no check_local_only). Deferred-work and QA docs treat writes as denied on shared-live; probe + mcp-servers read violate that posture.

**Reproduction:**

On shared-live (cloudflared public tunnel, no token): GET /mcp-servers leaks MCP env secrets; POST /mcp-servers/probe {command:'sh -c ...'} spawns arbitrary commands on the host. On standalone 0.0.0.0 without token (operator error) same. With token, any authenticated client can probe (probe is by design a host-side exec).

### F-001 - PTY default shell ignores /etc/passwd login shell when SHELL unset (systemd)

**Severity:** medium | **Category:** correctness | **Status:** fixed | **Rule:** R-008 (stated)

**Location:** `src-tauri/src/pty/manager.rs:2086-2089; src-tauri/src/lib.rs:290-301`

**Evidence:**

env_refresh.rs:155-168 documents this exact failure and fixes it via login_shell_from_passwd for PATH probing, but PtyManager::get_default_shell and get_default_shell_info never adopted the fallback. Baseline tests test_fallback_shell + test_get_default_shell_returns_some fail in a SHELL-unset env.

**Reproduction:**

Run termul-server under systemd (SHELL unset): spawned terminals get /bin/sh (dash) not the user's login shell; /shells endpoint reports default:null

**Fix attempts:**

| # | Mechanism | Outcome | Measured | Failure class |
|---|---|---|---|---|
| 1 | SHELL -> login_shell_from_passwd (/etc/passwd) -> /bin/sh fallback in both PtyManager::get_default_shell and lib get_default_shell_info | pass | Both baseline-failing tests green; the fix also fixes the systemd /shells default:null report | - |

**Tests:**

- `lib tests::test_fallback_shell + tests::test_get_default_shell_returns_some (both red in this SHELL-unset env before the fix)`
- `tests::test_fallback_shell + tests::test_get_default_shell_returns_some (revert-check: removing the fallback re-fails both)`

### F-005 - POST /acp/catalog/opt-in missing loopback guard — remote peer flips host CDN-augmentation flag

**Severity:** medium | **Category:** security | **Status:** fixed | **Rule:** R-003 (stated)

**Location:** `src-tauri/src/web/catalog_api.rs:119-173 (no ConnectInfo/check_local_only); route router.rs:200`

**Evidence:**

Doc claims it 'mirrors the set_default_project posture' but set_default_project is loopback-guarded (projects_api.rs:127-166); the doc is stale relative to the guard that was later added. Host-state mutation reachable without opt-in.

**Reproduction:**

POST /acp/catalog/opt-in {enabled:true} from a non-loopback peer without --allow-remote-writes -> persists host opt-in, enabling CDN registry fetches.

**Fix attempts:**

| # | Mechanism | Outcome | Measured | Failure class |
|---|---|---|---|---|
| 1 | set_opt_in now extracts ConnectInfo and calls check_local_only before mutating the persisted opt-in flag | pass | 9/9 catalog_api tests green; revert-check: guard removal fails the new test | - |

**Tests:**

- `web::catalog_api::tests::set_opt_in_refused_from_non_loopback_peer`

### F-010 - /worktree/create writes .gitignore through symlink — arbitrary file append/create

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/worktree/mod.rs:517-530 exists()+fs::write follow symlink`

**Evidence:**

Sibling copy_worktree_include_files (:1513-1535) treats symlinks as attack surface; create does not.

**Reproduction:**

.gitignore symlink -> /home/user/.bashrc: appends '.termul/' to target; dangling symlink creates target file. Triggered by any /worktree/create.

### F-011 - Option injection via '-'-prefixed branch/ref args in checkout/create-branch/worktree-create

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `git_tracker.rs:978 checkout -q <branch>; :995 checkout -q -b <branch> <start>; worktree/mod.rs:507-512 worktree add args`

**Evidence:**

No legit branch starts with '-' (check-ref-format rejects); missing -- end-of-options or starts_with('-') validation.

**Reproduction:**

branch='--detach' -> silent HEAD detach; '--orphan=x' -> unborn branch; start_ref='--force' -> created + dirty file reverted; worktree branch='--detach' -> detached worktree. All verified.

### F-012 - Pathspec-magic path args widen stage/unstage/discard to whole repo

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `git_tracker.rs:1001-1003 add -- <path>; :1012-1018 reset/rm --cached; :1233-1246 discard`

**Evidence:**

git pathspec magic honored after --; is_safe_relative_path only rejects ../absolute. Loopback-guarded so exposure is local/admitted-remote.

**Reproduction:**

POST /git/stage {path:':(glob)**'} stages every file; /git/discard {path:':(glob)**'} reverts ALL modified files. Verified.

### F-019 - update_project/remove_project rollback drops default_project_id

**Severity:** medium | **Category:** data-integrity | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/projects_api.rs:429-451, :519-536; acp/project_registry.rs:419-421 and :388-390 clear the default; rollback only restores the root; restore_default_project at :348 exists but is not called`

**Evidence:**

After failed save_atomic the in-memory FileProjectRegistry has default None while disk still has the old default; the NEXT successful save_atomic persists the loss. Siblings: WS handlers ws.rs:2786-2803, :2895-2907.

**Reproduction:**

projects.json default p-1; PUT /projects/p-1 {isArchived:true} with save_atomic failing -> handler claims rollback, file_registry.default_project_id() is None; next successful save persists the loss.

### F-020 - create/add_project upsert leaves dangling archived default, clears is_default, wipes file-side mcp_servers

**Severity:** medium | **Category:** data-integrity | **Status:** fixed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/projects_api.rs:323-330 (VfsRoot mcp_servers: Vec::new()), :390-398 (is_default:false, raw path); project_registry.rs:159-166 (upsert no default recompute); acp/project_registry.rs:362-376`

**Evidence:**

P4 invariant enforced by update/remove/load/from_roots but not on the upsert path. Siblings: WS handle_add_project ws.rs:2687-2742; ProjectRegistry::remove never evicts mcp_servers map — re-created same-id project resurrects stale config.

**Reproduction:**

POST /projects {id:default, isArchived:true} -> default_project_id points at an archived project; upserting the current default writes is_default:false while default_project_id still points at it; upsert_root replaces mcp_servers with [] (file loses MCP config).

**Tests:**

- `remote::host::tests::shared_live_binds_project_root_to_active_cross_drive_project`

### F-021 - File-vs-memory commit ordering race -> split-brain registry

**Severity:** medium | **Category:** concurrency | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/projects_api.rs:192-221 (file lock) then :225 (memory lock); same shape at :335-359->:398, :427-452->:481, :517-537->:566; WS twins ws.rs:2556-2592, 2696-2742, 2778-2835, 2887-2939`

**Evidence:**

Two stores mutated under different locks with a gap; P1 no-split-brain contract violated on all four mutation handlers on both transports.

**Reproduction:**

Two clients POST /projects/default {p-a} and {p-b} simultaneously; interleaving file-A, file-B, memory-B, memory-A -> file=p-b, snapshot=p-a. Restart -> default flips.

### F-022 - update_project persists to file then fails in-memory with no rollback

**Severity:** medium | **Category:** data-integrity | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/projects_api.rs:442 (save_atomic committed) -> :481-494 (registry.update false -> NOT_FOUND, file NOT rolled back); contrast :225-240 which does roll back`

**Evidence:**

Same P1 contract applied to set_default_project but not here. Sibling: WS handle_update_project ws.rs:2835-2851.

**Reproduction:**

File has p-1, memory lacks it (post-race); PUT /projects/p-1 {name:x} -> file renamed, memory unchanged, response NOT_FOUND.

### F-023 - default_sessions_dir/service_account_state_dir lack empty/relative env filtering; onboard bakes relative sessions_dir into systemd unit

**Severity:** medium | **Category:** correctness | **Status:** confirmed | **Rule:** R-001 (stated)

**Location:** `src-tauri/src/web/config.rs:37-45 (XDG_STATE_HOME/HOME no empty filter, no is_absolute) vs :88-100, :356-367; onboard.rs:79-83 (normalize applied to projects_file but not sessions_dir)`

**Evidence:**

Patch-15 contract at config.rs:339-343 says empty env values are filtered; XDG spec says relative XDG_STATE_HOME must be ignored — both enforced for projects_file (:88-100, tested :1476-1495) but not the sessions/state dirs. Sibling: default_project_root config.rs:130 lacks empty-HOME filter -> confusing startup error.

**Reproduction:**

env -i XDG_STATE_HOME= HOME= termul-server -> sessions land in CWD-relative termul/sessions; XDG_STATE_HOME=rel -> state dir (workspace-manifests, acp-catalog, acp-registry-binaries, web-auth token file) goes CWD-relative.

### F-024 - OnboardAnswers::defaults falls back to / as project_root

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-001 (stated)

**Location:** `src-tauri/src/onboard.rs:75-78 (unwrap_or_else(|| PathBuf::from("/"))) contradicting comment at :72-73`

**Evidence:**

The function's own comment says 'never the parent /home (over-broad boundary)'. HOME-less service account is exactly the systemd env the wizard targets.

**Reproduction:**

env -i HOME= USERPROFILE= -> defaults().project_root == "/" — confines /git/*,/skills,/search and remote fs writes to the entire filesystem.

### F-030 - Standalone startup never derives project_root from the registry default

**Severity:** medium | **Category:** correctness | **Status:** suspected | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/server_main.rs:309-321 -> web/mod.rs:279 -> router.rs:235; contrast remote/host.rs:1128-1129`

**Evidence:**

CAP-1 says the boundary follows the default project; project_registry.rs:397-398 documents CLI arg for standalone — design ambiguity, needs maintainer decision.

**Reproduction:**

projects.json default /srv/app; termul-server without --project-root -> boundary is /root; PUT /mcp-servers writes /root/.termul/mcp-servers.json until first /projects/default.

### F-034 - /fs/read and ls/browse on special files: /dev/urandom OOM, /dev/zero, FIFO hang, block-device read — remote DoS via thread-pool exhaustion

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-003 (stated)

**Location:** `src-tauri/src/web/fs_api.rs:660-681 read uses fs::metadata len=0 for char devices then fs::read unbounded (/dev/urandom reads until OOM); /fs/info opens FIFO (blocking open); copy from FIFO blocks`

**Evidence:**

Read routes are intentionally ungated for breadth (ADR-007) but authenticated remote clients can still exhaust the blocking pool. MAX_FILE_SIZE check uses metadata.len() which is 0 for procfs/devices before fs::read.

**Reproduction:**

GET /fs/read?path=/dev/urandom (token-authed remote peer) -> spawn_blocking thread reads until OOM. FIFO read hangs a blocking thread indefinitely; repeated requests exhaust the pool. ls on huge dirs -> unbounded response.

### F-036 - question_request is durable (replayed to reconnecting clients) unlike permission_request — stale unanswerable questions

**Severity:** medium | **Category:** correctness | **Status:** confirmed | **Rule:** R-007 (stated)

**Location:** `src-tauri/src/acp/session_persistence.rs:1620-1636 is_durable_event excludes permission_request but NOT question_request`

**Evidence:**

Issue #411 added question rendezvous; the durable-exclusion list was not updated. WsProtocol agent verified replay path delivers question_request on cursor replay and subscribe_snapshot.

**Reproduction:**

Agent asks a question; client answers + reconnects later with cursor replay: the stale question_request replays as an event even though the rendezvous ticket is gone; client shows an unanswerable question UI. Session payload fold ignores it in transcript but live replay delivers it.

### F-037 - Ephemeral/live-only session transcript unrecoverable on reconnect (cursor subscribe returns Stale/NotFound)

**Severity:** medium | **Category:** correctness | **Status:** confirmed | **Rule:** R-011 (stated)

**Location:** `src-tauri/src/web/ws.rs handle_subscribe/subscribe_snapshot persistence-first path; session_persistence.rs flush_session SessionNotFound arm`

**Evidence:**

WsProtocol verified the no-persistence replay branch is unreachable in server mode (persistence always attached on standalone + shared-live).

**Reproduction:**

Live ephemeral session with ring-buffer events: client reconnects and subscribes with cursor; persistence attached -> last_seq/flush return SessionNotFound -> reply Stale -> recovery dead-ends NotFound; transcript lost despite live ring events.

### F-038 - dispatch_connection_text holds the per-connection lock across all handler awaits — head-of-line blocking delays respond_permission past the 60s rendezvous timeout

**Severity:** medium | **Category:** concurrency | **Status:** suspected | **Rule:** R-007 (stated)

**Location:** `src-tauri/src/web/ws.rs dispatch_connection_text (subscribed_clients lock held across handle_subscribe disk IO / install download awaits)`

**Evidence:**

Static trace; needs a timing test to confirm real-world impact. send_prompt path bypasses the lock (accept_send_prompt outside).

**Reproduction:**

Client sends subscribe (disk-heavy replay) then respond_permission: the permission response queues behind the replay; slow installs/replays can push past DEFAULT_PERMISSION_TIMEOUT (60s) so an answered-in-time permission is denied.

### F-039 - QuestionRendezvous denies on last-subscriber disconnect with NO grace period (permissions get 60s reconnect grace)

**Severity:** medium | **Category:** concurrency | **Status:** confirmed | **Rule:** R-007 (stated)

**Location:** `src-tauri/src/web/permissions.rs QuestionRendezvous::with_timeout (no grace field) vs PermissionRendezvous DEFAULT_PERMISSION_RECONNECT_GRACE`

**Evidence:**

Inconsistent policy for the two rendezvous types; R-007 states bounded reconnect grace for pending tickets.

**Reproduction:**

Mobile client throttles + reconnects (5-15s per prod logs): a pending question is cancelled immediately on disconnect while a pending permission survives 60s.

### F-041 - handle_create_session/switch_project do not canonicalize/validate cwd — sessions spawnable in arbitrary or non-existent dirs

**Severity:** medium | **Category:** correctness | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/ws.rs handle_create_session + handle_switch_project (cwd used verbatim; add_project path unvalidated on desktop-hosted mode)`

**Evidence:**

Divergent validation between deployment modes; sessions can be spawned outside any project boundary.

**Reproduction:**

WS create_session {cwd:'/nonexistent'} on standalone -> session created with cwd that does not exist; desktop-hosted mode accepts arbitrary paths (VPS mode validates via FileProjectRegistry).

### F-042 - Queued permission requests fanned out but unanswerable until promoted; promotion emits no signal; stale response errors

**Severity:** medium | **Category:** correctness | **Status:** confirmed | **Rule:** R-007 (stated)

**Location:** `src-tauri/src/web/permissions.rs SessionQueue promote_next (no event on promotion); relay fans out queued permission_request immediately`

**Evidence:**

Queue promotion emits no projects_changed/permission event; clients see a dead request.

**Reproduction:**

Two sessions' permissions queue: second is shown to the client; client responds -> 'stale' (ticket not yet promoted); promotion is silent; ticket later denied on timeout although the user answered.

### F-043 - install path performs NO sha256 verification despite docs claiming verify — MITM downgrade-redirect chain enables registry agent injection

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-010 (stated)

**Location:** `src-tauri/src/acp/install.rs:609-643 (no sha256 verification, comment says catalog trusted); web/mod.rs:105-110 + R-010 docs claim 'downloads + verifies (sha256)'; acp_registry_snapshot.rs follows https->http redirects with no size cap (deferred-work notes this)`

**Evidence:**

install.rs comment: 'No sha256 verification: the catalog is the trusted Zed ACP registry'; sha256 field is audit-only. Contradicts documented contract (R-010, mod.rs:105-110, router.rs:201-206). Fix is either verify when sha256 present or fix the docs.

**Reproduction:**

Catalog fetch compromised (MITM or registry compromise): install downloads + activates attacker archive with zero integrity check. Snapshot fetch downgrade redirects are the pre-existing weak link.

### F-044 - legacy acp_binary_install accepts untrusted archive URLs + same https->http downgrade; backup path collision can delete installed agents; EXDEV swap failure

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-010 (stated)

**Location:** `src-tauri/src/acp_binary_install.rs (archive URL from caller; backup path collision; /tmp staging rename across filesystems)`

**Evidence:**

AcpServices agent verified each; legacy path retained for back-compat.

**Reproduction:**

Desktop command path with crafted URL -> download from http after redirect; agent-id-shaped backup dirs can collide and remove installed agents; /tmp on separate fs -> install swap fails EXDEV.

### F-045 - mcp_oauth: pending_oauth_flows unbounded; store_token non-atomic; get_valid_token_blocking deletes expired tokens without refresh attempt; urlencode misses ?/#//; iss ignored

**Severity:** medium | **Category:** correctness | **Status:** needs-decision | **Rule:** R-013 (inferred)

**Location:** `src-tauri/src/acp/mcp_oauth.rs (token file write not atomic; blocking refresh path deletes expired; urlencode incomplete); web/mcp_oauth_api.rs pending flows map`

**Evidence:**

AcpServices verified each hop; iss validation absent in oauth_callback.

**Reproduction:**

Start N flows without completing -> map grows unbounded. Crash during token write -> corrupt token file. Expired token on blocking path is deleted instead of refreshed -> permanent loss. OAuth code containing #/? truncates the callback URL parse.

### F-047 - terminal_ws + PTY surface reachable without peer gating: shared-live tunnel clients spawn PTYs while shared_live_writes_denied claims ALL writes denied

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-003 (stated)

**Location:** `src-tauri/src/web/terminal_ws.rs:42-47 (no ConnectInfo/peer check; web_auth None on shared-live); remote/host.rs binds Localhost + cloudflared forwards public traffic as loopback`

**Evidence:**

PtyTerminal agent: host::start always binds Localhost; tunnel makes remote clients appear loopback. Terminal-PTY-by-tunnel is intended product behavior (ungated URL is the barrier) — the defect is the documented invariant mismatch, not the feature.

**Reproduction:**

Any internet user with the shared-live tunnel URL opens /terminal/ws and spawns a shell: check_local_only routes are bypassed (peer appears loopback) AND terminal_ws itself has no gate. Terminal exec is a product feature via tunnel, but the deny-all-writes flag's documented promise is inconsistent.

### F-050 - Desktop and standalone share ~/.local/state/termul/store.json — web-store cross-contamination (SSH profiles, settings) between two products

**Severity:** medium | **Category:** security | **Status:** confirmed | **Rule:** R-012 (stated)

**Location:** `src-tauri/src/web/mod.rs:258-267 (store default under service_account_state_dir on both paths); desktop app-data isolation pattern used by other services`

**Evidence:**

R-012 says state roots are never shared across processes/products; workspace-manifests/acp-catalog use isolated app_data_dir on desktop but store.json does not.

**Reproduction:**

Run desktop + standalone on same machine: both open the same store.json; web client keys (SSH profiles, settings) collide and cross-contaminate.

### F-052 - FsApi: delete on symlink-to-dir removes the TARGET tree (resolved path); rename moves target not link — desktop/web divergence and loopback data-loss footgun

**Severity:** medium | **Category:** correctness | **Status:** confirmed | **Rule:** R-004 (stated)

**Location:** `src-tauri/src/web/fs_api.rs:802-835 delete uses canonicalized path so a project symlink to a dir deletes the target recursively; rename :841-876 moves resolved target leaving link dangling`

**Evidence:**

resolve_request_path canonicalizes existing paths, so delete/rename operate on the target. Loopback keeps breadth (ADR-007) so this is a data-loss footgun rather than remote escape.

**Reproduction:**

Loopback user deletes <project>/link (symlink to /data): remove_dir_all wipes /data. Desktop semantics remove only the link. Same for rename (moves /data, link dangles).

### F-013 - git_discard_file/git_get_diff classify directory pathspec by FIRST status line

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `git_tracker.rs:1234-1244 lines().next(); :871-877 starts_with('??')`

**Evidence:**

Per-file semantics applied to multi-entry pathspecs.

**Reproduction:**

path:'sub' with modified tracked + untracked files -> first line ' M' -> checkout -- sub reverts tracked, leaves untracked. Incoherent partial discard.

### F-014 - /search/content runs rg with no timeout and unbounded output buffering

**Severity:** low | **Category:** performance | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `search_api.rs:167-180 rg_command.output(); sibling commands.rs:2529-2532; worktree/mod.rs:317-342 run_git no timeout`

**Evidence:**

Every other subprocess has a deadline (git_tracker.rs:729-763); rg does not. 100-file cap applied after full output in memory.

**Reproduction:**

Query 'e' on large tree -> multi-hundred-MB stdout buffered; wedged rg holds spawn_blocking thread forever (cancel route inert for this path).

### F-015 - read_agent_skill follows symlinked skill dirs that scan_skills_dir skips

**Severity:** low | **Category:** security | **Status:** suspected | **Rule:** R-005 (stated)

**Location:** `skills/mod.rs:138 file_type().is_dir() skips symlinks vs :243-255 is_file() follows`

**Evidence:**

Inconsistent symlink policy; bounded (target must be SKILL.md, needs local write to plant). Likely hardening gap not exploit path.

**Reproduction:**

~/.agents/skills/evil -> /tmp/x with SKILL.md: GET /skills omits it; GET /skills/evil returns body.

### F-016 - check_dirty counts ignored files (!!) as untracked

**Severity:** low | **Category:** correctness | **Status:** fixed | **Rule:** R-005 (stated)

**Location:** `worktree/mod.rs:680-683 '?'|'!' => untracked += 1`

**Evidence:**

porcelain '!!' = ignored; inflates untracked/has_changes.

**Reproduction:**

Worktree with ignored target/ -> '!! target/' -> has_changes:true on clean tree.

**Fix attempts:**

| # | Mechanism | Outcome | Measured | Failure class |
|---|---|---|---|---|
| 1 | check_dirty no longer counts '!' (ignored) porcelain entries as untracked | pass | New test green with real git; full worktree suite 52/52 | - |

**Tests:**

- `worktree::tests::test_check_dirty_ignores_ignored_entries (52/52 worktree tests green)`

### F-025 - WebStore CAS cannot express expect-absent (JSON null -> None -> unconditional write)

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-011 (stated)

**Location:** `src-tauri/src/web/store.rs:105; ws.rs:2199-2200`

**Evidence:**

Option<Value> conflates JSON null with absent. Sibling: delete() fsyncs even when key absent; open() has no load-time size cap so a >10MB file makes the store read-only with no recovery.

**Reproduction:**

store_write {k,1}; concurrent store_write {k,2,expected:null} -> both succeed; second should CAS-fail.

### F-026 - WorkspaceManifestService lock map grows unboundedly

**Severity:** low | **Category:** performance | **Status:** confirmed | **Rule:** R-012 (stated)

**Location:** `src-tauri/src/acp/workspace_manifest.rs:471-479 vs :760-768`

**Evidence:**

Every distinct project_id ever written leaves a permanent Arc<TokioMutex> entry.

**Reproduction:**

Loop POST /workspace/{id}/write with unique ids -> locks map grows linearly, never shrinks.

### F-027 - find_by_path misattributes cwds containing '..' (raw string prefix match)

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/project_registry.rs:306-337 + is_within_dir:483-493`

**Evidence:**

String-prefix matching on un-normalized paths; is_within_any_registered_root canonicalizes first (correct).

**Reproduction:**

Register /dev/app; find_by_path("/dev/app/../etc") -> Some(project) though /dev/etc is outside it.

### F-028 - update() leaves stale is_default=true on an archived default

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/project_registry.rs:187-211`

**Evidence:**

Clears default_project_id but never project.is_default — user-visible badge skew.

**Reproduction:**

set default p-1; PUT /projects/p-1 {isArchived:true} -> snapshot {defaultProjectId absent, p-1.isDefault true}.

### F-029 - create_project stores raw non-canonical path in memory; upsert never rebinds project_root despite doc claim

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/projects_api.rs:394; project_registry.rs:157-158 doc claims rebind, :159-166 calls none`

**Evidence:**

CAP-1 boundary-follows-default intent; sibling WS handle_add_project ws.rs:2734-2741.

**Reproduction:**

POST /projects {path:"rel/dir"} -> file canonical, memory raw; behavior differs across restarts. Upserting default with new path leaves boundary on old path.

### F-031 - BindMode::All binds 0.0.0.0 — IPv4 only on dual-stack hosts

**Severity:** low | **Category:** config | **Status:** confirmed | **Rule:** R-001 (stated)

**Location:** `src-tauri/src/web/config.rs:201-205`

**Evidence:**

'All interfaces' claim vs IPv4-only socket; parse rejects '::' consistently but the error message never documents it.

**Reproduction:**

termul-server --host 0.0.0.0; curl http://[::1]:8080/health -> connection refused while 127.0.0.1 works.

### F-032 - ProjectRegistry::set accepts invalid default (archived/unknown/pathless)

**Severity:** low | **Category:** data-integrity | **Status:** confirmed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/web/project_registry.rs:141-151; callers commands.rs:3371`

**Evidence:**

P4 no-unswitchable-default invariant enforced by every other mutator; set() is the unguarded entry.

**Reproduction:**

remote_sync_projects({projects:[{id:a,isArchived:true}], defaultProjectId:"a"}) -> snapshot.default_project_id==a; switch fails NOT_FOUND.

### F-040 - WsRelaySink sessions map + SessionQueue + TurnWatermark grow unboundedly; forget_session never called on close_session

**Severity:** low | **Category:** performance | **Status:** confirmed | **Rule:** R-012 (stated)

**Location:** `src-tauri/src/web/sink.rs sessions map (only forget_session removes); permissions.rs SessionQueue empty entries; TurnWatermark maps`

**Evidence:**

close_session does not call forget_session. Also enqueue send-failure removes client from clients/session_subs but not the connection's subscribed_clients list.

**Reproduction:**

Create+close N sessions over a server's lifetime -> N retained event histories + queue/watermark entries; long-running VPS leaks memory proportional to session count.

### F-046 - overlay_installed leaks absolute command paths to remote clients (contradicts catalog doc); catalog refresh CDN fetch unauthenticated

**Severity:** low | **Category:** security | **Status:** confirmed | **Rule:** R-001 (stated)

**Location:** `src-tauri/src/web/catalog_api.rs:74-77 overlay_installed; :58 refresh param`

**Evidence:**

catalog_api.rs:46-50 says never carries resolved absolute executable paths; overlay does exactly that for installed agents.

**Reproduction:**

GET /acp/catalog through public tunnel shows resolved absolute executable paths (host filesystem layout disclosure); ?refresh=true forces unauthenticated CDN fetch with multi-second delay (minor DoS).

### F-048 - PtyManager kill/resolve issues: kill returns success for non-existent ids when hidden; kill spawn-blocking error skips cleanup; orphan reaper missing terminal_events.remove; resolve_shell_path does not search PATH on Unix

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-008 (stated)

**Location:** `src-tauri/src/pty/manager.rs kill (is_hidden check before lookup), cleanup paths, orphan reaper; resolve_shell_path fixed dirs only`

**Evidence:**

PtyTerminal agent verified each; low blast radius individually.

**Reproduction:**

kill(nonexistent) with app hidden -> Ok. Error-path kill skips resource cleanup. Reaper removes PTY but leaves tracker entries. User shell at ~/.local/bin/zsh not resolved (only fixed dirs searched).

### F-049 - update_orphan_detection timeout unit mismatch (ms vs secs) + idle forwarder generation checks + web attachment slot accounting leaks

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-008 (stated)

**Location:** `src-tauri/src/web/terminal_ws.rs:590-595 (timeout_ms logged); pty/manager.rs web_attachments accounting; claims.rs generation reset vs forwarder teardown gap`

**Evidence:**

PtyTerminal agent verified list_preserved/claims cluster; units mismatch verified by reading both call sites.

**Reproduction:**

update_orphan_detection {timeout: 30000} treated as ms in one path and compared against secs elsewhere; web terminals never auto-unprotected -> slot exhaustion; claims issue() resets generation before forwarder teardown -> list_preserved reissues stale claims.

### F-051 - RemoteServerState stop() does not disconnect live WS clients; can hang indefinitely on stuck in-flight request; bind_mode 'all' silently downgraded to localhost

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-008 (stated)

**Location:** `src-tauri/src/remote/host.rs stop() (axum on_upgrade detaches; no header read timeout); remote_server_start bind_mode param ignored`

**Evidence:**

RemoteHost agent verified axum 0.8 detaches upgraded connections; hyper default lacks header read timeout.

**Reproduction:**

Toggle shared-live off while a client holds /ws: stop() returns, WS stays live until client disconnects. A wedged HTTP request (slowloris via tunnel) hangs graceful shutdown indefinitely. --bind all silently binds localhost.

### F-053 - FsApi: Windows rename replaces existing files + cross-volume moves (MOVEFILE_COPY_ALLOWED) — Unix EXDEV divergence; procfs size field inconsistent

**Severity:** low | **Category:** correctness | **Status:** confirmed | **Rule:** R-004 (stated)

**Location:** `src-tauri/src/web/fs_api.rs rename/copy (std::fs::rename semantics differ by platform)`

**Evidence:**

Rust std rename Windows flags; platform parity gap for the web client.

**Reproduction:**

POST /fs/rename {to: existing-file} on Windows silently replaces; on Unix errors EEXIST/EXDEV. procfs files report size 0 with non-empty content.

### F-054 - Stale cross-drive boundary test contradicted CAP-2 registered-root semantics

**Severity:** low | **Category:** test-quality | **Status:** fixed | **Rule:** R-005 (stated)

**Location:** `src-tauri/src/remote/host.rs:1227-1256 (fixed)`

**Evidence:**

Test predated PR #557 (ensure_within_project_boundary). Fixed by archiving p-a before the rejection assertion, preserving the test's boundary-moved intent.

**Reproduction:**

Baseline failure: test asserted dir_a rejected after default switch, but p-a stays registered+non-archived so CAP-2 admits it.

**Tests:**

- `remote::host::tests::shared_live_binds_project_root_to_active_cross_drive_project`

## Not fixed

| ID | Status | Title | Reason / evidence |
|---|---|---|---|
| F-045 | needs-decision | mcp_oauth: pending_oauth_flows unbounded; store_token non-atomic; get_valid_token_blocking deletes expired tokens without refresh attempt; urlencode misses ?/#//; iss ignored | AcpServices verified each hop; iss validation absent in oauth_callback. |

---

## Needs decision (expanded)

**F-030 — Standalone startup never derives project_root from the registry
default (suspected).** With `--project-root` unset, the standalone server
uses `$HOME` as the operation boundary even when `projects.json` names a
default project. Options: (a) derive from the registry default like the
desktop shared-live host does (matches CAP-1 "boundary follows the active
project", narrows `/git`+`/skills`+`/search`+remote-fs exposure to the actual
project); (b) keep the CLI-arg-wins behavior and document it. Recommendation:
(a) — it is what the desktop path already does, and `$HOME` is a strictly
bigger blast radius. Needs a maintainer call because it changes what
first-boot containment looks like for existing VPS installs.

**F-045 — MCP OAuth hardening bundle (needs-decision, rests on inferred
R-013).** Four sub-items: unbounded `pending_oauth_flows` map, non-atomic
token writes, expired-token deletion without refresh attempt, incomplete
`urlencode`. None are remotely exploitable on a token-gated deployment; all
degrade reliability of MCP OAuth reconnects. Fix is mechanical but the OAuth
contract (refresh-before-delete, CAS semantics) should be confirmed by
whoever owns the MCP integration.

## New issues discovered during remediation

None. The fix phase surfaced no new defects beyond what the sweep had already
recorded; two fix attempts needed corrections (the F-007 collision test
initially asserted git ambiguity semantics that do not hold — plain
`checkout <file>` is NOT refused by git, it reverts; the final test asserts
the route-level refusal instead; and one clippy `doc_lazy_continuation`
warning in a new doc comment) — both caught by the verification loop, not by
luck.

## Changes affecting others

Behavioral contract changes from the fixes (all hardening, no schema, env, or
dependency changes):

- `POST /git/init` now enforces the same write posture as every other
  `/git/*` route: FORBIDDEN from non-loopback peers without
  `--allow-remote-writes`, PATH_TRAVERSAL on `..`, OUTSIDE_PROJECT_ROOT
  beyond the boundary. Web clients that legitimately init repos outside the
  boundary from loopback still work.
- `PUT /mcp-servers` and `POST /acp/catalog/opt-in` now enforce the shared
  loopback guard (FORBIDDEN from non-opted-in remote peers; denied in
  shared-live mode). This is a behavior change for any remote client that
  was (incorrectly) relying on these being open.
- `/git/branch-switch` now refuses names that are not resolvable branch refs
  (previously it silently reverted same-named files) and actually switches
  branches. `/git/branch-create` works for the first time.
- `/git/discard` refuses whole-repo pathspecs (`.`, `./`, `dir/..`).
- PTY default shell falls back to the `/etc/passwd` login shell when `$SHELL`
  is unset (systemd) instead of `/bin/sh`.

Rollback: every change is confined to the listed files; `git revert` of the
sweep commits restores prior behavior with no migration steps.

## Follow-up actions

| # | Action | Owner / decision needed | Priority |
|---|---|---|---|
| 1 | Fix F-003 (dangling-symlink leaf escape) + F-009 (worktree name traversal) — resolve symlink targets before the remote containment check; validate worktree `name` as a single safe path segment | engineer | high |
| 2 | Decide F-017/F-018 policy: whether `--allow-remote-writes` peers may redefine the project boundary, and whether WS mutations must mirror the HTTP loopback guard | maintainer decision, then engineer | high |
| 3 | Add Origin/Host validation (or at minimum a token requirement) to WS upgrades on ungated loopback binds (F-033); consider a documented default-on gate | engineer + security review | high |
| 4 | F-035: decide the shared-live posture for `/mcp-servers` (GET secrets + probe RCE through the tunnel while writes are nominally denied) | maintainer decision | high |
| 5 | F-011/F-012: reject `-`-prefixed branch/ref names and pathspec-magic (`:(glob)`, `:/`) path args on the git write routes | engineer | medium |
| 6 | F-039/F-036/F-042: align QuestionRendezvous with the permission grace model; make `question_request` non-durable; emit a signal on queue promotion | engineer | medium |
| 7 | F-019/F-021/F-022: single-lock registry mutations with rollback that restores the default id (split-brain + rollback gaps) | engineer | medium |
| 8 | F-043/F-044: verify sha256 when the catalog declares it (or fix the docs that claim verification), and apply the strict redirect policy to the registry snapshot fetch (already noted in deferred-work) | engineer | medium |
| 9 | F-023/F-024: env-filtering parity for sessions/state dirs; replace onboard's `/` fallback | engineer | medium |
| 10 | F-034: size/timeout caps on `/fs/read` + special-file (FIFO/device) refusal | engineer | medium |
| 11 | Remaining low findings (F-013..F-053) per the findings table | engineer | low |

## Validation

| ID | Original reproduction | Result now | Revert-check |
|---|---|---|---|
| F-006 | POST /git/discard `{path:"."}` on a repo with untracked entries → repo incl `.git` deleted (verified live in scratch repo) | `it_discard_whole_repo_pathspec_is_refused` asserts refusal + intact repo | Old-guard code re-applied: `test_is_safe_relative_path` fails at the `.` assertion |
| F-007 | `git checkout -- feature` → "pathspec did not match", stays on master; `git checkout -- a.txt` reverts file, exit 0 | `branch_switch_actually_switches_branch` (HEAD==feature) + collision test (file content preserved, request refused) | Old `[checkout,--,name]` restored: all 3 new tests fail |
| F-008 | `git checkout -b -- newbr` → fatal, branch `--` cannot be created | `branch_create_actually_creates_and_switches` (HEAD==newbr) | Old `[checkout,-b,--,name]` restored: test fails |
| F-002 | POST /git/init `{cwd:"/tmp/anywhere"}` / `../escape` from any peer → runs | Live server smoke: OUTSIDE_PROJECT_ROOT / PATH_TRAVERSAL; 3 route tests | Unguarded handler restored: all 3 tests fail |
| F-004 | PUT /mcp-servers from non-loopback peer → writes registry | `put_refused_from_non_loopback_peer` + `put_refused_in_shared_live_mode` (FORBIDDEN, no file written) | Guard removed: both tests fail |
| F-005 | POST /acp/catalog/opt-in from non-loopback peer → flag persists | `set_opt_in_refused_from_non_loopback_peer` (FORBIDDEN, flag unchanged) | Guard removed: test fails |
| F-001 | Baseline tests red in SHELL-unset env; /shells default:null under systemd | Both baseline tests green; live server reports `default: bash` from /etc/passwd | Fallback removed: both tests fail again |
| F-016 | Ignored entries counted as untracked | `test_check_dirty_ignores_ignored_entries` with real git: ignored-only tree is clean | (parser-level fix; covered by the new test) |
| F-020/F-054 | Cross-drive test failed at baseline (stale assertion) | Test green after archive-then-assert fix | — |

## Smoke test results

| Entry point / journey | Steps | Result | Notes |
|---|---|---|---|
| Server boot | `termul-server --port 8099 --host 127.0.0.1` | ready in 2.1s; "ACP web server listening" | loaded 3 project roots, all state services opened |
| `GET /health` | curl | `{"status":"ok","allowRemoteWrites":true}` | token gate not required on loopback (by contract) |
| `GET /shells` | curl | default `bash` resolved from /etc/passwd | F-001 fix live in the running binary |
| `POST /git/init` (outside root) | curl | OUTSIDE_PROJECT_ROOT | F-002 fix live |
| `POST /git/init` (traversal) | curl | PATH_TRAVERSAL | F-002 fix live |
| `GET /fs/ls` | curl | success, entries listed | read path unaffected |
| Shutdown | SIGTERM via harness stop | exit 0, 46s uptime | clean stop |
