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
| `GPUIX_BACKGROUND=1`     | Open the window without taking focus (headless and agent runs)    | unset                              |

Scripts:

- `bun run dev` bundles, runs the bundle under `bun --hot`, and rebuilds when
  `src/`, `../../src/renderer` or `../../src/shared` change. A rebuild remounts
  the tree in the same window; state resets (GPUIX has no React Refresh on desktop).
- `bun run build` writes `dist/main.js`; `bun run start` builds and runs it once.
- `bun run typecheck` runs both tsc projects (see below).
- `bun run check:react` proves the bundle shares one React 19 with `@gpuix/react`.
- `bun run parity <scenario>` runs the pixel-parity harness.
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
