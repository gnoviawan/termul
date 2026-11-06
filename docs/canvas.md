# Canvas

The canvas is a built-in design editor. Each project opens one canvas tab backed by a `.figcraft` document in the project directory. The editor is the figcraft web bundle running in an iframe. Termul serves the bundle, persists the document, and gives agents the figcraft tools. There is no sidecar process and no second copy of the document outside the iframe.

This page describes the shipped design. The architecture decisions it follows are the canvas spine decisions AD-17 to AD-31 (kept in the planning artifacts, not in this repository).

## How it fits together

```text
renderer          canvas tab -> CanvasShell iframe /canvas/<id>/?embed=kiosk&ct=...
                  canvas-bridge.ts   postMessage, figcraft control protocol
                  canvas-api.ts      facade -> tauri-canvas-api.ts / web-canvas-api.ts
host              src-tauri/src/canvas/
                    static_server.rs   bundle serving, canvas token store, path gate, open/close
                    persistence/       mount registry, lease, autosave, conflicts, close sequence
                    pin.rs             the bundle tag this build expects
                  src-tauri/src/web/canvas_api.rs, canvas_persistence_api.rs   web routes
                  src-tauri/src/commands/canvas.rs                             Tauri commands
                  src-tauri/src/acp/host_mcp/canvas*.rs                        agent gateway
bundle            canvas/figcraft.pin -> canvas/bundle/ (embedded, same asset set as the web UI)
```

- **One document authority.** The figcraft engine inside the iframe is the only live copy of a document. Every read or write of document state, including agent tool calls, goes through that iframe.
- **Termul owns the file.** The editor emits `event.dirtyChanged`. The host waits for `canvas.autosave_ms` of quiet, asks the editor for a `host.snapshot`, writes the `.figcraft` bytes atomically, then calls `host.markSaved`. A user save skips the debounce.
- **Same URL shape everywhere.** The desktop app binds a loopback listener on `127.0.0.1:0` and iframes it. `termul-server` and the desktop shared-live host serve the same bundle same-origin under `/canvas/<id>/`. Remote clients only ever reach the canvas through those routes.

## Documents

A canvas document is a `.figcraft` file. Opening the canvas picks the project root's alphabetically first `.figcraft` file, or creates `design.figcraft` on the first save. Other extensions are never opened as a canvas. The file explorer opens a `.figcraft` file as the project's canvas tab.

After every load the renderer sends the editor `host.file {name, path, location}`: the file stem (`design`), the project-relative path that `save_file` also reports (`design.figcraft`), and the project name. The editor's header, window title, `inspect_document` and `inspect_ui` show them, and the project name takes the place of figcraft's "Drafts". The editor never receives an absolute path. A bundle older than the call answers `UNKNOWN_METHOD`, and the document then shows as "Untitled".

## Lifecycle

- **Mount once per project.** The first open mounts the iframe. Closing the tab hides the mount (an offscreen 1x1 visible iframe, never `display:none`) so agents can keep working. A mount ends on project close, an explicit close, eviction, or lease loss.
- **Cap and eviction.** At most `canvas.max_mounted` canvases stay mounted (default 2, clamped to 1..16). Opening one more saves and unloads the least recently active one. A failed save blocks the eviction.
- **One lease per document.** Exactly one renderer (a desktop window or a web tab) holds a document's mount. A newer opener takes the lease, and the previous holder unmounts and shows `CANVAS_OPEN_ELSEWHERE` with a take-back action. A dropped connection keeps the lease for `canvas.lease_grace_ms` (default 5000) so a reload does not lose it. An agent call that arrives in that window waits for the holder to come back, up to the call timeout, and answers `CANVAS_CLOSED` once the grace runs out.
- **Close sequence.** Every unmount runs quiesce, save, verify, unmount. If the save fails the user is asked and nothing is discarded silently.
- **Crash recovery.** An `event.crashed`, or `canvas.crash_timeouts` consecutive timed-out calls (default 3), remounts the editor from the last saved bytes. The editor runs one call at a time, so a call that times out while an earlier call is still inside its own, longer wait (a large export) is not counted.
- **Disk changes.** Termul's file watcher owns detection. A clean editor reloads silently. A dirty editor suppresses autosave and the user chooses keep mine, take disk, or save a copy.

## Settings

The renderer sends these with each canvas open, and the host clamps them.

| Setting | Default | Meaning |
| --- | --- | --- |
| `canvas.autosave_ms` | 1500 | Quiet time before a dirty document is autosaved |
| `canvas.lease_grace_ms` | 5000 | How long a window keeps its lease after its connection drops |
| `canvas.max_mounted` | 2 | Mounted canvases kept at once |
| `canvas.crash_timeouts` | 3 | Consecutive timed-out calls that mark the editor crashed |
| `canvas.call_timeout_ms` | 10000 | Gateway timeout for one agent call (`CANVAS_TIMEOUT`). Renders wait longer, see [Agents](#agents) |

## Access control

The iframe cannot send an `Authorization` header, so the bundle has its own credential, separate from the web auth bearer.

- `open` mints a per-canvas token (32 hex characters from the OS CSPRNG) and reuses it on repeat opens.
- The token is a path segment: the iframe loads `/canvas/<id>/<token>/`, so the bundle's relative sub-resource URLs carry it too. Tokens are compared in constant time.
- No cookie is involved. On the desktop the loopback iframe is a cross-site frame inside the app webview, and WKWebView (macOS) and WebKitGTK (Linux) drop third-party cookies by default.
- `close` revokes the token, so stale URLs stop working.
- The token is never logged. Every log line that names a request path writes the token segment as `[redacted]` (`canvas::bundle_path::redact_canvas_path`).
- The `/canvas/open`, `/canvas/close` and persistence routes stay behind the web auth bearer. They are write routes: a view-only peer (remote peer without write access, or the desktop shared-live host) is refused with `FORBIDDEN`. A doc path must lie inside the root of the project that opens it (a registered, non-archived project), on the web routes and the desktop commands alike.

## Agents

Canvas tools live in the per-session host `termul` MCP server (`acp/host_mcp`). The gateway resolves the session's project, forwards each call to the renderer that holds the mount's lease, and answers from the engine. It caches no document or selection state. Tool names are figcraft's own. `save_file` is Termul's own save of the project document. The gateway refuses with `UNSUPPORTED_IN_KIOSK` every engine command that reads or writes files outside that save and `export`, leaves the project's document, or makes the editor reach past the canvas: live sessions and online files (every `collab.*` command), the sharing server preference (`pref.publishServer`), linked and team libraries, plugin directories, font downloads and opening links (`acp/host_mcp/canvas_policy.rs`). A call that runs another command is routed as each command it runs: a `command.batch` step, the command a `text.preview` previews, or the shortcut a `key` press (`ui.key`) runs, that would be refused on its own refuses the whole call, naming that command. The key is looked up in figcraft's default key bindings on both macOS and Windows/Linux, on the canvas and while editing text, because Termul cannot see which of those the editor uses. So `Cmd+N`, `Cmd+W`, `Cmd+O`, `Cmd+S`, `Shift+Cmd+S`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Alt+Enter` and `/` are refused. A batch step param the policy reads (an export `path`, a preview's `command`) that is a `$step`, `$ref` or `$name` reference to an earlier step's result is refused, because the engine fills it in after the check. `edit.repeat` is refused, because it runs the editor's last command again, which may be the user's and which the gateway never saw. A project with no mount answers `CANVAS_CLOSED`, a closing one `CANVAS_CLOSING`, and a stalled editor `CANVAS_TIMEOUT`. No MCP registry entry is persisted for the canvas, and no `/canvas/mcp` route exists. On load the renderer drops any `canvas-mcp-*` entries an older build persisted.

The same server carries Termul's design harness, the `termul-canvas` skill (`acp/host_mcp/canvas_skill.rs`). `read_canvas_guide({topic?})` returns the skill's Markdown from `src-tauri/resources/canvas-skill/`: `SKILL.md` with no topic, else one guide such as `canvas-basics` or `landing-page`. `get_canvas_style({name?})` lists the curated style archetypes in `styles.json`, or returns one with an `apply` batch that creates its colour, spacing and radius variables. The files are compiled into both binaries, versioned with Termul rather than the engine, and need no open canvas. The session instructions tell agents to read the index and the required topics before their first edit. Every style uses Inter only, the one Latin design-text family the canvas bundle embeds. Tests run each guide's `canvas-batch` examples and each style's `apply` batch on the pinned engine, so property names in the guides cannot drift. `scripts/canvas-eval/` measures the harness against a baseline.

Calls that render pixels (a png, jpg or webp `export`, and the render behind `screenshot`) wait `canvas.call_timeout_ms` plus 2 s per output megapixel, at most 180 s. The output size is the union of the target layers' bounds times the scale, read from the editor with `node.get` or `document.inspect` lookups that never count toward the crash timeouts. When the bounds cannot be read the render gets the full 180 s. An export with a `path` that still times out keeps running in the editor, and Termul writes its file when it finishes, within 10 minutes, unless a newer export to the same path started first. The engine cannot be interrupted, so a call that timed out may still finish. The `CANVAS_TIMEOUT` advice depends on the tool: a read (`get_node`, `inspect_document`, `list_commands`, `inspect_ui`, `wait_for_changes`) may be retried once, an `export` or `screenshot` should use a smaller `scale` or `size`, and any other call should re-read the document before redoing anything, since a blind retry can apply a change twice. Engine-side cancellation and rejecting `scale` above 64 (the engine clamps it) are fork follow-ups.

`wait_for_changes` waits for new comment events, the only events the engine records. The editor page answers `events.poll` at once, because its one thread could add no event while it waited. The host `Bridge` (`acp/host_mcp/bridge.rs`) therefore polls again every 250 ms with the same params until events arrive, the event log resets, or the wait passes, as figcraft's own control server does: `timeoutMs`, 20 s by default and at most 25 s. It then returns the last reply. Each poll is a separate canvas call, so a hidden canvas still answers, and a closed one ends the wait with `CANVAS_CLOSED`.

Every answered agent call also shows on the canvas as that session's cursor (`acp/host_mcp/presence`). The host derives what the call touched from the call and its result, looks up the last node's bounds with at most one `node.get` or `document.inspect`, and sends the editor `host.guestCursor`, `host.guestFlash` and, when the turn ends or the session closes, `host.guestHide`. The cursor carries the agent's display name and a colour fixed by the session id. Moves are paced to one per 120 ms per session. This work starts after the agent's reply and never delays or fails it. Its lookups never count as canvas activity or toward the crash timeouts. Nothing is sent when no editor is connected.

## Interfaces

| Surface | Desktop (Tauri command) | Web (`termul-server`) |
| --- | --- | --- |
| Open a project canvas | `canvas_open` | `POST /canvas/open` |
| Close, with optional discard | `canvas_close` | `POST /canvas/close` |
| Persistence round trip | `canvas_read_document`, `canvas_document_loaded`, `canvas_dirty_changed`, `canvas_set_visible`, `canvas_write_snapshot`, `canvas_disk_changed`, `canvas_resolve_conflict`, `canvas_crashed` | `POST /canvas/read-document`, `/document-loaded`, `/dirty-changed`, `/set-visible`, `/write-snapshot`, `/disk-changed`, `/resolve-conflict`, `/crashed` |
| The bundle | loopback listener `http://127.0.0.1:<port>/canvas/<id>/<token>/` | `GET /canvas/<id>/<token>/` |

Both transports share the same Rust service and typed error codes. Every facade method exists in both `tauri-canvas-api.ts` and `web-canvas-api.ts`, and parity tests hold them together.

## The bundle

- **Pin.** `canvas/figcraft.pin` holds the fork's release tag, download URL and sha256. CI fails when it disagrees with the `figcraft-mcp` dependency tag in `src-tauri/Cargo.toml`.
- **Fetch.** `bun scripts/canvas/fetch-figcraft-bundle.mjs` downloads the pinned zip, verifies the checksum and unpacks it to `canvas/bundle/`. `--zip <file>` uses a local zip. The release and nightly workflows run it before their Rust builds, and the bundle is embedded alongside the web UI.
- **Dev override.** Set `TERMUL_FIGCRAFT_BUNDLE` to a built bundle directory (a figcraft checkout's `dist-web`) to serve it instead of the embedded one.
- **Missing bundle.** A release build without `canvas/bundle/index.html` fails to compile and names the fetch command. Set `TERMUL_ALLOW_MISSING_CANVAS_BUNDLE=1` (or `true`) to build without the canvas on purpose, for example offline or for `cargo test --release`. A debug build, or a release build under the override, logs a warning and answers the canvas routes with the typed `BUNDLE_MISSING` error. The rest of Termul is unaffected.
- **Fork.** The bundle comes from `gnoviawan/figcraft` (branch `termul`). Its patches are limited to the web host API, the kiosk flag, the brand knob, the theme hook and guest presence (the agent cursor).
- **Fallback fonts.** Design text can use two font families the bundle embeds, Inter and Noto Sans Georgian (for figcraft's Georgian interface). The editor's wasm also embeds egui's interface fonts (Ubuntu Light, Hack, Noto Emoji and emoji-icon-font), which draw only the editor's own panels and never design text. A web build cannot read system fonts. On the desktop the loopback listener lends the editor a few Windows fonts for the characters Inter lacks: Segoe UI Symbol, Microsoft YaHei, Malgun Gothic and Segoe UI Emoji, whichever are installed (`canvas/fallback_fonts.rs`). It serves them at `/canvas/<id>/<token>/host-fonts/<file>`, the open info lists their URLs, and the renderer sends them in `host.fallbackFonts` before it loads the document, so the first render and an agent's first screenshot have them. `termul-server` and the shared-live host list and serve none, because they would send this machine's fonts to another one. macOS and Linux lend none yet.
- **Licences.** The bundle embeds the design-text fonts Inter and Noto Sans Georgian, both under the SIL OFL 1.1. `canvas/licenses/` holds tracked copies of their licences (`OFL-inter.txt`, `OFL-noto-sans-georgian.txt`). The unpacked bundle carries `NOTICE` and an `OFL-<family>.txt` for each of the 29 families in figcraft's font catalog (craft-fonts), which Termul embeds and serves with it, including families the web build does not embed. The egui interface fonts the editor's wasm embeds have tracked licences there too: `UFL-ubuntu.txt` (Ubuntu Font Licence 1.0), `LICENSE-hack.txt` (MIT and the Bitstream Vera licence), `OFL-noto-emoji.txt` (SIL OFL 1.1) and `MIT-emoji-icon-font.txt` (MIT, also covering egui's five-glyph `egui-icons` subset of it). The bundle's own `NOTICE` carries only the emoji-icon-font licence text. FigCraft is MIT OR Apache-2.0. FigCraft, both design-text fonts and the interface fonts are credited in the README acknowledgments.

## Retired: the OpenPencil daemon

An earlier canvas embedded OpenPencil as a managed `op-host-web-server` sidecar, one daemon per `.op` document. It was replaced by figcraft and removed in E4-1. Gone with it:

- the daemon pool and spawner, the stdout handshake, and the `TERMUL_OP_HOST_SERVER` and `TERMUL_OPENPENCIL_ROOT` binary lookup,
- the HTTP proxy to the daemon, including the root `/pkg`, `/canvaskit` and `/api` relays (those paths are plain SPA paths now),
- `.op` document handling, the `canvas_save`, `canvas_status` and `canvas_bundle_base` commands, and the `/canvas/save`, `/canvas/bundle-base` and `/canvas/mcp` routes.

The per-canvas token store survived. Its cookie gate was later replaced by the token path segment. Nothing needs migrating: a `.op` file is not a canvas document and is ignored.
