# Termul GPUIX client

An experimental desktop client that renders Termul natively with
[GPUIX](https://gpuix.dev) (React 19 reconciled onto Zed's GPUI) and talks to a
standalone `termul-server` over the HTTP and WebSocket transport the browser
client already uses. The stores, facades and hooks come from `src/renderer`
through the bundler; nothing is copied.

## How to build and try it

Linux x64 on X11 is the tested platform. Under Wayland the app runs, but
browser panes are off.

### System libraries

To run the app (the `.deb` lists these as dependencies):

```sh
sudo apt install libxcb1 libxkbcommon0 libxkbcommon-x11-0 libvulkan1 \
  mesa-vulkan-drivers libwebkit2gtk-4.1-0 libgtk-3-0
```

The GPUIX addon links the X11 and xkbcommon libraries and loads Vulkan at run
time. `mesa-vulkan-drivers` is the Vulkan driver for Intel, AMD and lavapipe
(software); with an NVIDIA card its driver provides one. WebKitGTK and GTK are
for the browser-pane helper and for `termul-server`, which links them through
the shared Tauri crate.

To build from a checkout you also need Bun 1.4, `bun install` at the repo root
(without the root `node_modules` Bun auto-installs packages that bypass the
bundler's aliases), and Rust for `termul-server`.

### Run from the checkout

```sh
bun install && bun run build:web               # at the repo root
(cd src-tauri && cargo build --release --bin termul-server --features standalone-server)

cd apps/gpuix
bun install
TERMUL_SERVER_BIN=$PWD/../../src-tauri/target/release/termul-server \
TERMUL_GPUIX_DATA_DIR=/tmp/termul-gpuix-try \
  bun run dev
```

`bun run dev` bundles the client, runs it under `bun --hot`, and rebuilds when
`src/`, `../../src/renderer` or `../../src/shared` change. A rebuild remounts
the tree in the same window and resets its state. `bun run start` builds once
and runs the production bundle.

With no `TERMUL_SERVER_URL`, the app manages its own server
([docs/launcher.md](./docs/launcher.md)). It starts `termul-server` on a free
loopback port with a fresh token, waits for it, and stops it when the window
closes. The binary is `TERMUL_SERVER_BIN`, else a `termul-server` beside
`dist/main.js`, else the first one on `PATH`.

### Where the data lives

The managed server opens the Tauri desktop app's data dir, so projects,
sessions and installed agents carry over:

| Platform | Data dir |
| --- | --- |
| Linux | `$XDG_DATA_HOME/com.termul-manager.app`, else `~/.local/share/com.termul-manager.app` |
| macOS | `~/Library/Application Support/com.termul-manager.app` |
| Windows | `%APPDATA%\com.termul-manager.app` |

Only one app can hold that dir. While the Tauri app runs, GPUIX shows
"Another Termul host owns <dir>" with a Retry button. Set
`TERMUL_GPUIX_DATA_DIR` to a scratch dir, as above, to try GPUIX without
touching your real data or quitting the Tauri app.

Per-device UI state (terminal layout, editor state, settings, command history)
does not carry over: the GPUIX client registers as a new device. The client
keeps its own state, the managed server's record and its log
(`launcher/server.log`) in `TERMUL_GPUIX_STATE_DIR`, default
`$XDG_STATE_HOME/termul-gpuix` (`~/.local/state/termul-gpuix`).

To attach to a server you started yourself instead:

```sh
TERMUL_WEB_AUTH_TOKEN=dev-token termul-server --port 8192 --state-dir /tmp/termul-gpuix-dev
TERMUL_SERVER_URL=http://127.0.0.1:8192 TERMUL_SERVER_TOKEN=dev-token bun run dev
```

An attached client never starts or stops that server. Set
`TERMUL_GPUIX_DATA_DIR` to the server's `--state-dir` as well to get the
host-local features (Claude accounts, SSH).

| Variable | Meaning | Default |
| --- | --- | --- |
| `TERMUL_SERVER_URL`, `TERMUL_SERVER_TOKEN` | Attach to this server (an origin, no path) with this bearer token | unset: manage a server |
| `TERMUL_SERVER_BIN` | The `termul-server` to start | beside `dist/main.js`, then `PATH` |
| `TERMUL_GPUIX_DATA_DIR` | The server's `--state-dir`: where a managed server keeps its data; for an attached client, where to read `host-local.token` | the Tauri data dir (managed), unset (attached) |
| `TERMUL_GPUIX_STATE_DIR` | The client's own state (web storage, launcher record and log) | `$XDG_STATE_HOME/termul-gpuix` |
| `TERMUL_GPUIX_SERVER_PORT` | Pin the managed server's port | the last port, else a free one |
| `TERMUL_GPUIX_KEEP_SERVER=1` | Leave the managed server running on quit for the next launch to reuse | unset |
| `NAPI_RS_NATIVE_LIBRARY_PATH` | Load this `@gpuix/native` addon instead of the npm one | unset |
| `GPUIX_BACKGROUND=1` | Open the window without taking focus (headless and agent runs) | unset |
| `GPUIX_START_HASH` | Boot on this hash route (`#/snapshots`); the parity matrix uses it for a route no desktop shell links to | unset: the dashboard |

### The patched native addon

Italic text, the chat's link colour, inline-code chip and table cells,
overlay backdrop blur, DOM-ordered focus events, focus rings on text fields,
`z-index` stacking, the save dialog and the browser pane's window lookup need
Termul's patches to `@gpuix/native` 0.11.0
([docs/native-patches.md](./docs/native-patches.md)). A checkout runs the
published npm addon until you build the patched one and point the app at it:

```sh
sudo apt install gcc g++ libfontconfig-dev libwayland-dev libxkbcommon-x11-dev \
  libx11-xcb-dev libssl-dev libzstd-dev libvulkan1    # and rustup
bun run native:build       # about 20 min cold, 2 to 4 min after a patch change, seconds when unchanged; ~4 GB in ~/gpuix-native-target
export NAPI_RS_NATIVE_LIBRARY_PATH=$PWD/native/gpuix-native/build/gpuix-native.linux-x64-gnu.node
bun run native:patch-check # one on-screen check per patch; fails on the published addon
bun run dev
```

`TERMUL_GPUIX_NATIVE_WORK` moves the work dir. The build stops itself past
14 GB of work dir or under 8 GB free on `/`.

### Build the `.deb`

```sh
bun run native:build                       # first, so the package ships the patched addon
CARGO_TARGET_DIR=<a target dir with the desktop build> bun run package:linux
sudo apt install ./dist-package/termul-gpuix_<version>_amd64.deb
termul-gpuix                               # or "Termul Manager (GPUIX)" in the app menu
```

The package installs under `/opt/termul-gpuix` with its own Bun, the client
bundle and fonts, the native addon, a release `termul-server` (built with
`--features standalone-server`, embedding `dist-web/`), ripgrep and the
webview helper. It ships the self-built addon by default. When that file is
missing it falls back to the npm addon and prints an error;
`--native-addon npm` asks for the npm addon on purpose. `--server-bin FILE`
and `--webview-host FILE` reuse prebuilt binaries and skip cargo. It installs
beside the Tauri package (`termul-manager`) and opens the same data dir.
`termul-gpuix --check-update` reports a newer release; the app never installs
updates itself. `bun run package:verify` extracts the `.deb` under `/tmp` and
drives it under Xvfb without installing it. See
[docs/packaging.md](./docs/packaging.md).

### Other scripts

- `bun run build` writes the production bundle (`dist/main.js` sets `NODE_ENV=production`, then loads the minified `dist/main.bundle.js`; `--dev` builds React's development bundle instead). On Linux it also builds the browser-pane helper; `bun run build:webview-host` builds only the helper.
- `bun run typecheck` runs the tsc projects (see below), `bun run test` the unit tests.
- `bun run check:react` proves the bundle shares one React 19 with `@gpuix/react`.
- `bun run parity <scenario>` runs the pixel-parity harness; `bun run parity:matrix` the full parity matrix ([docs/parity-matrix.md](./docs/parity-matrix.md)).
- `TERMUL_SERVER_BIN=<fresh termul-server> bun tools/launcher/host-local-e2e.ts` runs the real launcher against that server and checks the `/ws` grant: `hostLocal` with the credential, not without it, not through a proxy header, and for an attached client only with `TERMUL_GPUIX_DATA_DIR`.
- `bun tools/live-rename.ts` shoots the project list, renames a project through the server API while the app runs, and shoots again.

## How the shared code runs under Bun

`build.ts` bundles `src/main.tsx` with `Bun.build`. Its plugin mirrors the
alias map of `vite.config.web.ts`: `@/`, `@renderer/`, `@shared/` point into
the repo, `@tauri-apps/*` resolve to `src/renderer/lib/tauri-stubs` (an
unmapped one throws at load with the package name), and `sonner` becomes
`src/shims/sonner.ts` because the real package writes a stylesheet into
`document.head` on import. `react`, `react-dom` and `@gpuix/*` stay external
so the bundle, `@gpuix/react`, zustand and every vendored library load the one
React in `apps/gpuix/node_modules`. A runtime `Bun.plugin` could not do this:
on Bun 1.4.0 its `onResolve` never sees static ESM imports (measured).

`main.tsx` parses the config, installs the environment seam, and only then
loads the app tree with a dynamic import, so no `src/renderer` module evaluates
before the globals exist.

### The environment seam (`src/env/`)

`installBrowserEnv()` defines the browser globals the shared code touches on
the paths this client imports, and nothing more. Each entry was added when a
run needed it:

| Global                                        | Who reads it                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `window.location` (origin, protocol, host, …) | `serverBase()`, `resolveWsUrl()`, `resolveTerminalWsUrl()`, the host probe   |
| `window.localStorage`, `localStorage`         | device id, web auth token, client identity releases                          |
| `window.sessionStorage`, `sessionStorage`     | client instance id, protocol-mismatch latch                                  |
| `window` as an `EventTarget`                  | `focus`/`blur`/`pageshow`/`online` listeners of the WS transport, `pagehide` |
| `document` as an `EventTarget` + `visibilityState: 'visible'` | the WS transport, `useProjectRegistry`, persistence flushes   |
| `window.innerWidth` / `innerHeight`           | GPUIX's automation `initialize` reply, which reads them when `window` exists |

`localStorage` is a `FileStorage`: one JSON file per server origin under the
state dir (`web-storage/<host>.json`, mode 0600), written atomically shortly
after the last change and on exit. `sessionStorage` is in memory, because a
process is the analogue of a tab: persisting it would carry the
protocol-mismatch latch across restarts, which the browser never does.

`window.__TAURI_INTERNALS__` stays undefined, so `isTauriContext()` is false
and every facade picks its web transport. The token from `TERMUL_SERVER_TOKEN`
goes through `setWebAuthToken()`, the same path as the token-entry screen.

### Two tsc projects

`tsconfig.json` checks the app side (`boot.tsx`, `App.tsx`, the shims and
everything they pull from `src/renderer`) with the DOM lib and no ambient Node
types, like `tsconfig.web.json`. `tsconfig.tools.json` checks `main.tsx`,
`env/`, `build.ts` and `tools/` with `@types/bun`. They cannot be one program:
Bun's ambient types make `setTimeout` return `Timeout` and `import.meta.env`
a string map, which breaks shared browser files. The bridge is `#app/boot`:
package.json `imports` maps it to `boot.tsx` for the bundler, the tools
tsconfig maps it to `boot-contract.ts`, and `boot.tsx` is typed against that
contract.

## Parity harness (`tools/parity/`)

```sh
bun run parity projects            # port 8193, output in parity-out/projects/
```

1. `server.ts` starts a throwaway `termul-server` (binary from
   `TERMUL_SERVER_BIN`, else `/root/gpuix-bin/termul-server`, else the
   `src-tauri` release build) with a fixed token and its own state dir, and
   seeds it over HTTP.
2. `scenarios.ts` names the seed and the test ids both clients paint once the
   state is on screen (`data-testid` on the web, `testId` in GPUIX).
3. `shoot-web.ts` opens the web client in Playwright chromium at 1280x800,
   dark scheme, reduced motion. The server serves the `dist-web` of the
   checkout it was built from, so static files are answered from this
   worktree's `dist-web` (`bun run build:web` at the root first); the service
   worker is blocked and the local-network-access check disabled so the
   route-fulfilled page can open sockets to 127.0.0.1. The token and a fixed
   device id are seeded into `localStorage` before the first script runs.
4. `shoot-gpuix.ts` starts `Xvfb -nocursor` on a free display, launches the
   bundle through `@gpuix/react/automation` with the lavapipe Vulkan ICD and
   `GPUIX_BACKGROUND=1`, waits for the test ids, and grabs the frame with
   `ffmpeg -f x11grab -draw_mouse 0` (GPUIX's own `screenshot()` is not
   available on Linux).
5. `diff.ts` writes `diff.png` and prints two numbers: `exact` (any channel
   differs) and `perceptual` (pixelmatch, threshold 0.1). On a dark theme the
   perceptual count ignores most background shade differences, so it flatters
   the result; the exact count is the one to track.

Add a scenario by adding an entry to `SCENARIOS` with its seed and ready ids.

## Shared DOM components on GPUIX (`src/compat/`)

Shared `src/renderer` components render on GPUIX unchanged. `build.ts`
points their `react/jsx-runtime`, `react` and `react-dom` at `src/compat`, so
each `<div className=… onClick=…>` becomes a GPUIX element when it is
created. Files under `apps/gpuix` keep the real runtime, except the Radix,
framer-motion, cmdk and react-resizable-panels stand-ins in `src/compat/radix`
and `src/compat/shims`.

- `translate.ts` maps a tag and class string to a style once and caches it,
  so an unchanged element keeps the same style object across renders.
- `children.ts` lays out text. GPUIX has no inline formatting context, so
  plain text merges into one node and mixed inline content becomes a
  wrapping row of word runs.
- `events.ts` turns DOM handlers into GPUIX listeners and bubbles mouse
  events through ancestors, which GPUIX does not do past a filled box.
- `hover.ts` gives `mouseenter`/`mouseleave` DOM semantics. GPUIX ends a hit
  test at the first absolutely placed or filled interactive box, and that box
  blocks its own ancestors too, so a rail row lost its hover as soon as its
  hover-revealed action strip painted under the pointer, hid the strip, and
  looped. Every such box now reports its GPUI hover and hands clicks on to
  its ancestors (`addOccluderListeners`), and an element counts as hovered
  while GPUI hovers it or a blocking box inside it. Presses (`mousedown`,
  `mouseup`) are not handed on. The first settle that meets a blocking box reads the
  painted tree for its ancestors, which waits for a frame (about 75 ms under
  lavapipe); the chain is then kept for the box's life.
- `dom-node.ts` is what `ref`, `event.target` and `document.activeElement`
  return. Tree queries read a mirror of the retained tree.
- `host.tsx` is the only per-element component. It is used only for
  `group-*`, `focus:`, `focus-within:` and breakpoint variants, and for the
  `group` element itself.
- `dnd.ts` is HTML5 drag and drop. A press on a `draggable` element that
  travels 4px runs `dragstart`, `drag`, `dragenter`/`dragleave`, `dragover`,
  `drop` and `dragend` with a `DataTransfer` in the DOM's protected and
  read-only modes. The source carries mouse down, move and up, so GPUIX
  captures the pointer. The target is a DOM-style hit test over the last
  painted tree: GPUIX's `getElementsAt` hides every subtree under compat's
  click-through boxes. An OS file drop (`onFileDrop`, X11 XDND) runs
  `dragenter`, `dragover` and `drop` with the paths as `File`s; `src/env/files.ts`
  opens them and provides `FileReader`. There is no drag out to the OS and
  no hover feedback before an OS drop lands.
- `placement.tsx` also rebuilds percentage offsets (`left-1/4`,
  `style={{ top: '25%' }}`), which GPUIX rejects, from spacer rows.
- `shims/resizable-panels.tsx` stands in for `react-resizable-panels`: panels
  register with their group, sizes are flex-grow percentages, and the grab
  strips sit in an overlay that paints after the panels.

The ui primitives in `src/ui` build their host element through the same
`buildElement`.

A native replacement for a shared file goes at
`src/overrides/<path under src/renderer>` and must export the same names.
The bundler uses it for every importer. `bun run compat:lint` fails when a
shared file uses a DOM API the compat layer lacks
(`src/compat/dom-support.ts`) and has no override or
`tools/compat/overrides.json` entry.

Tools:

- `bun tools/dnd/check.ts [--only os-drop,toc,tabs,split,resize,explorer]`
  drives drag and drop in the real shell and asserts on the result: an OS
  file dropped on the composer, the outline handle, tab reorder, split by
  drag, divider drag and its persistence across a restart, an Explorer file
  dropped on a pane. Output goes to `/tmp/gpuix-d1/dnd/`.
- `bun tools/dnd/parity.ts` shoots the same pane drag in the web client and
  GPUIX (two tabs, right zone held, split) and diffs them.
- `bun tools/clickloss/run.ts [--trials N] [--modes auto,auto-move,xtest,xtest-nofocus]`
  clicks rail rows, the hover-revealed gear and the fade of the action strip
  on a seeded server through GPUIX automation and through real X input
  (XTEST), and exits non-zero on any lost click. `COMPAT_TRACE_POINTER=1`
  (set by the tool) logs every compat pointer listener to stderr; the logs
  land in `$GPUIX_STATE_ROOT` (default `/tmp/gpuix-h1`). Real X input under
  Xvfb is a valid harness: Xvfb has XInput 2.0 with a master pointer, and
  GPUI's "Found no xinput mouse pointers" only means no pointer has a scroll
  class (`tools/clickloss/xi-devices.py` prints them), so presses and motion
  arrive as from a mouse. This Xvfb keeps XInput 2.0 even with
  `-extension XInputExtension`, and the host has no Xephyr, Xvnc or Xorg, so
  a server without XI2 was not tried. The loss was not an X artifact: at
  20 trials per target, exp/gpuix-client at 9747b6c2 lost 68 of 180 clicks,
  52 of them through automation input, which never touches X. With
  `hover.ts`, the same 180 trials lost none. Real X input with and without the
  script's input focus then passed 120 of 120. `--entry` runs another checkout's built
  `dist/main.js` for such a comparison.

- `bun tools/compat/parity.ts [fixture…] --port N` diffs StatusBar, ShellRail,
  ChatMessage and ConfirmDialog against the web build. Output goes to
  `parity-out/compat/`.
- `bun tools/compat/bench/run.ts --runs N --rows N` times the real
  `ProjectItem` through compat against a direct GPUIX version of the same
  rows. Add `--loop mount` or `--loop rerender` to repeat one phase with no
  sleeps and compare JS-thread CPU time, which other load on the host
  inflates less than wall time.

## Chat transcript (`src/overrides/components/chat`, `src/chat`, `tools/chat`)

The transcript is native. `ChatMessageList` puts the shared timeline rows
into `<virtual-list alignment="bottom" followTail>`; an agent reply becomes
one row per block (`AgentReplyRows`), each block a native `<markdown>`, a
`<code>` card (`CodeCard`) or a table card, spaced with the web stylesheet's
collapsed margins (`prose-flow.ts`). `AgentProse`, `ThoughtGroup` and
`highlighted-code` have native twins; tool rows, activity and user bubbles
render the shared components through compat. `tsconfig.chat.json` checks
this code; shared DOM components it renders are typed through
`src/chat/dom-components.d.ts`.

```sh
bun run chat:seed -- --port 8190 --hold   # a server with one scripted chat
bun run chat:parity                       # web vs GPUIX at bottom/middle/top -> parity-out/chat/
bun run chat:check                        # follow, jump-to-latest, thought expansion
bun run chat:perf -- --runs 3             # stream-storm cost, GPUIX vs Chromium -> perf-out/chat/
```

The scripted chat comes from `tools/chat/scenario-agent.ts` (an ACP stdio
agent playing `script.ts`: prose, code, a table, tool calls, thoughts, an
edit diff, mermaid). A prompt `storm <seconds> <rate> <chars>` makes it
stream at the perf toolkit's stream-storm shape and log each chunk.
`tools/chat/scene` is the GPUIX side: the transcript at the box the web
gives its viewport, driven through a control file (scroll, prompt, perf flush).

## Chat composer (`src/composer/`, `tools/composer/`)

tiptap needs contentEditable, and stock GPUIX 0.11 has IME only inside
`<textarea>`. The override of `components/chat/composer/ChatComposerEditor.tsx`
edits the draft in a native textarea that shows each pill as a label
(`@app.ts`, `/compact`). `src/composer/model.ts` keeps the document (text runs
and pills) and parses and serializes the shared sentinel display string with
the web's own `draftFromTokens` and `pillTokenText`. `reconcile.ts` diffs each
native change back onto the document, so a pill is deleted as a unit and an
edit inside a label lands after the pill. The caret is placed by walking it
with `simulateKeystrokes`, because 0.11 has no selection API.

The textarea consumes Backspace, the arrows and Enter as native actions. While
a composer menu lists options (it sets `aria-controls` on `inputRef`), focus
moves to a key-capture box: the host's `onBeforeEditorKeyDown` sees each key
first, and the rest edit the document directly. Hosts reach the editor only
through `components/chat/composer/editor-ops.ts`, which has a GPUIX twin.

- `bun tools/composer/e2e.ts` seeds a termul-server with a small project and a
  prompt-logging ACP agent, mounts the shared `ChatInputBar` on GPUIX, types
  through automation, and asserts on the prompt blocks the agent received.
- `bun tools/composer/parity.ts` shoots the web and GPUIX composers on one
  server (empty, mention menu, two pills) into `/tmp/gpuix-o3/parity/`.
- `bun tools/composer/probe/probe-run.ts` records which keys a stock textarea
  and a focusable box deliver to JS.

Both tool sets seed their servers through `tools/shared/` (`ws.ts`, the
authenticated `/ws` client; `seed.ts`, port picking and agent registration)
and bundle their scenes with `buildClient` from `build.ts`. They keep server
state and output under `/tmp/gpuix-o2` and `/tmp/gpuix-o3`; set
`GPUIX_STATE_ROOT` to use another directory.

## Browser panes (Linux X11, `native/webview-host`, `src/browser`)

A browser tab is a WebKitGTK webview in a helper process, `termul-webview-host`
(wry 0.55.1, the version `src-tauri` uses). The helper builds each webview as
an X11 child window of the GPUIX window, so the X server moves and clips it
with the app. The shared `BrowserPanel` and `useBrowserWebview` run unchanged:
`main.tsx` registers a browser host through `src/renderer/lib/browser-host.ts`,
and every `browser-api.ts` facade asks that host before its Tauri `invoke`.
The same registration turns on the New browser tab entry points and webview
occlusion (`nativeBrowserPanesAvailable()` in `browser-panes.ts`).

The app and the helper speak JSON lines over stdio (`src/browser/protocol.ts`
and `native/webview-host/src/protocol.rs`). Each command carries a `req` and
gets one `ack`; the helper also reports navigation, load, title, page console
output and keyboard ownership. Page console lines go to the client log as
`browser-console: [<tab id>] <level>: <text>`.

- **Build.** `bun run build` runs `cargo build` on `native/webview-host` and
  hard-links the binary to `dist/termul-webview-host`, where the client looks
  for it (`TERMUL_WEBVIEW_HOST_BIN` overrides). Cargo writes to
  `$CARGO_TARGET_DIR`, else to the repo's `src-tauri/target` when that already
  exists; with neither the helper is skipped instead of compiling GTK and
  WebKit from scratch. `TERMUL_GPUIX_SKIP_WEBVIEW_HOST=1` skips it outright.
- **Lifetime.** The helper starts with the first tab and runs one WebKit
  context for all tabs under `<state dir>/webview` (one profile, as in the
  desktop app): one network process, and a web process per tab that ends when
  its tab closes. Closing the window, `quit`, stdin EOF or the app dying
  (`PR_SET_PDEATHSIG`) ends the helper and its WebKit processes.
- **Overlays.** Webviews paint above GPUIX. The ui twins' dialogs, sheets,
  menus, popovers and selects register an occluder while open (boot hands
  them the renderer's `useNativeWebviewOcclusion`, see
  `src/ui/internal/occlusion.ts`), so the webviews unmap until the last
  overlay closes, as on the desktop. Shared code on the compat Radix path
  occludes through the shared `components/ui` wrappers, as it does on the
  desktop. Tooltips do not occlude, as on the web.
- **Bounds.** `useBrowserWebview` resizes the webview from its
  ResizeObserver callback. The compat ResizeObserver hands the box `onLayout`
  reported to the read memo (`src/compat/live-reads.ts`), so the callback's
  `getBoundingClientRect` answers without waiting for another frame. Like the
  DOM, a move without a size change reports nothing.
- **Keyboard.** A button press anywhere on the display is watched through
  XInput2 raw events. A press inside a webview gives it the X input focus; a
  press elsewhere in the window, or any GPUIX focus change, gives it back.
  While a webview does not have the keyboard, its X windows do not select key
  events, so keys never follow the pointer into it.
- **Unsupported.** Other platforms, a session without `DISPLAY`, and Wayland
  sessions get no browser panes and log why (`browser panes off: ...`). GPUI
  picks Wayland whenever `WAYLAND_DISPLAY` is set and does not fall back to
  XWayland, so there is no X11 window to embed into.

Checks, each under Xvfb with real X input through XTest (GPUIX automation input
never reaches X) and a test server on a free port in 8190-8199:

- `bun tools/browser/pane-check.ts` drives the real shell: URL bar, link,
  back and forward, a split, a stepped divider drag (30 fps strip capture)
  and continuous drags both ways (60 fps strip capture, counting the GPUIX
  divider positions the webview trails), Preferences with a dropdown and the
  New tab menu over the webview, keys into the page and back to the
  composer, two tabs and their WebKit processes, and quitting. It waits for a
  quiet machine before the divider drags (`waitForQuiet`) and records how
  busy it was. PNGs and `results.json` go to `/tmp/gpuix-b2/pane-check`.
- `bun tools/browser/unsupported-check.ts [--case missing-helper|wayland]`
  checks the unsupported state.

## Canvas (FigCraft, Linux X11, `src/browser/canvas-relay.ts`)

The canvas is a helper webview too. GPUIX has no iframe, so
`src/overrides/components/canvas/CanvasShell.tsx` replaces the DOM shell: it
asks the browser host for a canvas tab (`createCanvas`), and the helper loads
`native/webview-host/src/relay.html` from its `termul-canvas://localhost`
scheme. That page iframes the editor URL (the same one the DOM shell builds,
with `ho=termul-canvas://localhost`) and is the parent window FigCraft talks
to: what the editor posts goes to the app as `canvasMessage` events, and the
app's `post` commands are delivered to the editor. `createCanvasRelayFrame`
gives `canvas-bridge.ts` a frame whose `contentWindow` sends through the
helper and whose messages arrive on `window` as `message` events from that
`contentWindow`, so the bridge, the store and the agent gateway run unchanged.

- **Placement.** The webview covers the panel slot (`use-slot-rect.ts`, shared
  with the DOM shell). With no slot (tab closed or not shown) it moves out of
  the window at 1x1, as the DOM iframe does; under an overlay it moves out at
  its size. It stays mapped either way, so agent calls keep working on a
  hidden canvas. Closing the tab does not unmount the editor (AD-19); an
  unmount (another window takes the canvas, the app quits, the project goes)
  destroys the webview and ends its WebKit web process.
- **Theme.** `src/overrides/lib/canvas-theme.ts` reads the `host.theme` tokens
  from the GPUIX theme, since this process has no computed style.
- **Unsupported.** Without a canvas-capable host (Wayland, no helper, not
  Linux) the slot shows a notice instead of the editor.

`bun tools/canvas/canvas-check.ts` drives the real shell under Xvfb: Canvas
from the rail, agent `create_node` and `get_node` through the host's canvas
MCP tools (`tools/canvas/canvas-agent.ts`), Save, Preferences over the canvas
with an agent call while it is hidden, Ctrl+Z typed into the canvas, a split
with the chat composer taking the keyboard back, closing the tab, a second
project's canvas, a takeover that unmounts the first, and quitting. The test
server has no FigCraft bundle, so the check puts `tools/canvas/bundle-proxy.ts`
in front of it with the bundle `canvas/figcraft.pin` names (fetched and
sha256-checked by `scripts/canvas/fetch-figcraft-bundle.mjs`). For tools that
start their own server, `TERMUL_SERVER_BIN=tools/canvas/server-with-bundle.ts`
does the same, e.g. `bun tools/matrix/run.ts --only canvas.open`.

