# Termul GPUIX client

An experimental desktop client that renders Termul natively with
[GPUIX](https://gpuix.dev) (React 19 reconciled onto Zed's GPUI) and talks to a
standalone `termul-server` over the HTTP and WebSocket transport the browser
client already uses. The stores, facades and hooks come from `src/renderer`
through the bundler; nothing is copied.

## Run it

Requirements: Bun 1.4, the repo root's `node_modules` installed (`bun install`
at the root; without it Bun auto-installs packages from its cache and those
bypass the bundler's aliases), and a `termul-server` to talk to.

```sh
# a server on a spare port, token-gated
TERMUL_WEB_AUTH_TOKEN=dev-token termul-server --port 8192 --state-dir /tmp/termul-gpuix-dev

cd apps/gpuix
bun install
TERMUL_SERVER_URL=http://127.0.0.1:8192 TERMUL_SERVER_TOKEN=dev-token bun run dev
```

| Variable                 | Meaning                                                           | Default                            |
| ------------------------ | ----------------------------------------------------------------- | ---------------------------------- |
| `TERMUL_SERVER_URL`      | Origin of the server (no path)                                    | `http://127.0.0.1:8190`            |
| `TERMUL_SERVER_TOKEN`    | Bearer token for a gated server                                   | none                               |
| `TERMUL_GPUIX_STATE_DIR` | Where the client keeps its persisted web storage                  | `$XDG_STATE_HOME/termul-gpuix`     |
| `TERMUL_GPUIX_DATA_DIR`  | The server's `--state-dir`. A launched server uses it; an attached client on the same host reads the server's `host-local.token` from it, so it gets Claude Accounts and SSH | the desktop app data dir (launched), unset (attached) |
| `GPUIX_BACKGROUND=1`     | Open the window without taking focus (headless and agent runs)    | unset                              |

Scripts:

- `bun run dev` bundles, runs the bundle under `bun --hot`, and rebuilds when
  `src/`, `../../src/renderer` or `../../src/shared` change. A rebuild remounts
  the tree in the same window; state resets (GPUIX has no React Refresh on desktop).
- `bun run build` writes the production bundle (`dist/main.js` sets `NODE_ENV=production`, then loads the minified `dist/main.bundle.js`; `--dev` builds React's development bundle instead); `bun run start` builds and runs it once.
- `bun run build` also builds the browser-pane helper on Linux (see Browser
  panes below); `bun run build:webview-host` builds only the helper.
- `bun run package:linux` builds the installable `.deb` (Bun, the bundle, `termul-server`, the
  helper), and `bun run package:verify` runs it from `env -i` under Xvfb. See
  [docs/packaging.md](./docs/packaging.md).
- `bun run typecheck` runs both tsc projects (see below).
- `bun run check:react` proves the bundle shares one React 19 with `@gpuix/react`.
- `bun run parity <scenario>` runs the pixel-parity harness.
- `TERMUL_SERVER_BIN=<fresh termul-server> bun tools/launcher/host-local-e2e.ts` runs the real launcher against that server and checks the `/ws` grant: `hostLocal` with the credential, not without it, not through a proxy header, and for an attached client only with `TERMUL_GPUIX_DATA_DIR`.
- `bun tools/live-rename.ts` shoots the project list, renames a project through
  the server API while the app runs, and shoots again.

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

