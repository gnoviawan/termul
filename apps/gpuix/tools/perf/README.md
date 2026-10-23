# Linux client perf runner

This runner measures a Termul desktop client on Linux under the load of the `tools/perf` scenarios. It produces numbers that compare the current web client, run in Chromium today, with the GPUIX client later. Numbers from different machines are not comparable.

The runner treats the client as a black box with a process tree, a network connection, and a UI that a user drives:

- **Process cost.** The runner reads RSS, PSS, and CPU for every process in the client's tree from `/proc` every 500 ms. It also samples the `termul-server` tree and the whole machine, so a run shows how much CPU went to the client, to the server, and to everything else.
- **Transport.** A byte-counting TCP relay sits between the client and `termul-server`. Every HTTP response and WebSocket frame passes through it.
- **Terminal cost.** A probe program runs inside a terminal that the client opens. It times the client's terminal emulator from the inside. See [Terminal probe](#terminal-probe).
- **Page metrics.** Long tasks, long animation frames, and `requestAnimationFrame` cadence come from `tools/perf/metrics/page-observers.ts`. Only web clients have them.

The `browser` lane of `tools/perf` (`tools/perf/browser/`) is not used. It registers the fake agent through `/api/persistence`, a route that `termul-server` does not have, so its chats never stream. It also runs headless, samples no processes, and loads the server's compiled-in web assets instead of the worktree's build.

## Prerequisites

- `bun install` at the repository root and in `apps/gpuix`. The runner uses the root `playwright` package and Playwright's Chromium in `~/.cache/ms-playwright`.
- `bun run build:web` at the repository root. The runner serves this worktree's `dist-web/` in place of the assets compiled into the server.
- A `termul-server` release binary. The default is `/root/gpuix-bin/termul-server`. Override it with `--server-bin`.
- `Xvfb`. Each run starts its own display, by default `:181`. For `--gl lavapipe`, Mesa's lavapipe driver must be at `/usr/share/vulkan/icd.d/lvp_icd.json`.

## Run the baseline

From `apps/gpuix`:

```bash
bun run perf --scenarios stream-storm,pty-flood --runs 5 --gl lavapipe --out tools/perf/baseline/linux-chromium
bun run perf:report chromium=tools/perf/baseline/linux-chromium
```

The runner alternates the scenarios (stream-storm 1, pty-flood 1, stream-storm 2, and so on), so slow drift on a shared machine hits both scenarios equally. Every run starts a fresh Xvfb, a fresh server state directory under `/tmp/gpuix-b0/`, and a fresh browser profile.

Other units share the machine. Before each run, the runner waits until a 5 s sample of whole-machine CPU is under `--quiet-below` percent of one core, for at most `--quiet-wait` seconds. The run then starts either way, and its record keeps the sample (`meta.preRunBusyPct`) and the wait (`meta.quietWaitS`).

Output goes to `apps/gpuix/tools/perf/results/linux-<timestamp>/` unless you pass `--out <dir>`. The `results/` directory is ignored by git.

- `<scenario>-run<N>.json` contains one run. It has `meta` (flags, git commit, quiet-gate sample, load average, client version, GL backend string), `metrics` (flat numbers), `errors`, `notes` (raw probe results, per-chat start times, server process cost), `processes` (pid, role, command line), and `procSeries` (1 s samples).
- `aggregate.json` has the median, minimum, maximum, and run count of every metric over the successful runs of each scenario.

| Flag | Default | Meaning |
|---|---|---|
| `--scenarios` | `stream-storm,pty-flood` | Comma-separated list of scenarios. |
| `--runs` | `3` | Runs per scenario. |
| `--gl` | `lavapipe` | Chromium rasterizer. `lavapipe` is ANGLE on Mesa's Vulkan driver, the same driver that the GPUIX lane uses. `swiftshader` is Chromium's default on a machine with no GPU. `cpu` passes `--disable-gpu`. |
| `--port` | `8196` | Server port. The relay listens on `port + 1`. The runner fails if the port is taken. |
| `--display` | `:181` | Xvfb display. |
| `--width`, `--height` | `1440`, `900` | Window and screen size. |
| `--seed` | `42` | Seed for the fake agent and the probe content. |
| `--quiet-below` | `150` | Quiet-gate threshold, in percent of one core. |
| `--quiet-wait` | `600` | Longest quiet-gate wait, in seconds. |
| `--server-bin`, `--dist-web`, `--out` | see above | Paths. |

Any other `--<flag> <number>` overrides a scenario default, for example `--agents 2 --sustain 10`.

## Scenarios

The scenarios keep the shape of `tools/perf`, so the numbers line up with the Windows desktop lane.

**stream-storm.** The runner registers the fake ACP agent from `tools/perf/fake-agent/fake-agent.ts` in the server store, with seed 42, 20 updates per second per chat, 120-character chunks, and streaming until cancelled. `PERF_AGENT_UNIQUE_SESSIONS=1` gives each agent process its own session id, because `termul-server` starts one agent process per chat. The scenario opens `agents × sessions-per-agent` chats (default 4 × 2 = 8) through the launcher UI, the way a user does. The phases are:

1. `warmup`: the first chat opens, then 10 s pass.
2. `open-chats`: the other 7 chats open one after another. Each one waits until its tab exists and the launcher has closed. Its length depends on how fast the client responds.
3. `sustained-stream`: the visible chat changes every 5 s through the chat list for 30 s.
4. `measure`: 20 s with no input while all chats stream.

**pty-flood.** The scenario opens `terminals` (default 3) Bash tabs through the tab bar `+` menu. Each tab runs the paced probe at `lines-per-sec` (default 200) with the line mix of `tools/perf/fake-agent/flood.ts`. The phases are `warmup` (one terminal, 5 s), `flood` (the other terminals open, then 30 s), and `measure` (15 s). After every paced probe has finished, the `burst` phase writes `burst-lines` (default 20000) lines into the visible terminal as fast as the PTY accepts them.

Both scenarios begin with a `startup` window, from the `launch()` call until the launcher accepts input.

## Metrics

Every per-phase metric key is `<phase>.<metric>`.

| Key | What it measures | Limits |
|---|---|---|
| `startup.processUpMs` | `launch()` call until the browser process tree exists and the page is created. | Includes Playwright overhead. |
| `startup.projectListMs` | `launch()` call until the sidebar row for the seeded project is visible. This is the time to first project list. | Includes process start, bundle load, the WebSocket handshake, and the project fetch. Disk caches are warm after the first run. |
| `startup.launcherReadyMs` | `launch()` call until the launcher composer and the **Start** button are visible. This is the time to interactive. | Playwright polls, so the resolution is about one frame. |
| `<phase>.proc.<role>.rssMedianMB`, `rssMaxMB` | Summed RSS of the processes with that role. | RSS counts shared pages once per process. Summed over Chromium's processes, it overstates the footprint. |
| `<phase>.proc.<role>.pssMedianMB`, `pssMaxMB` | Summed PSS. | PSS splits shared pages between processes, so `proc.total.pss*` is the honest total for the whole client. |
| `<phase>.proc.<role>.cpuMeanPct` | Mean CPU in percent of one core. A value of 200 means two busy cores. | The 500 ms sampling averages out short spikes. |
| `<phase>.server.cpuMeanPct` | CPU of `termul-server` and the agents, shells, and probes that it starts. | The same work for every client. |
| `<phase>.machine.cpuBusyPct`, `foreignCpuPct` | Busy CPU of the whole machine, and the part of it used by neither the client nor the server. | `foreignCpuPct` is other units' work. A high value means the run competed for cores. |
| `<phase>.bytesDownKBps`, `bytesUpKBps` | Bytes through the relay per second of phase time, server to client and client to server. | The startup window excludes the JS bundle, which Playwright routes from disk. |
| `<phase>.page.fps`, `frameP50Ms`, `frameP95Ms`, `frameP99Ms`, `framesOver25Ms`, `framesOver50Ms` | `requestAnimationFrame` cadence in the page. | Web clients only. rAF runs only while the page produces frames, so a stalled compositor shows up as long frames. |
| `<phase>.page.longtasks`, `longtaskMs`, `longtaskMsPerSec` | Main-thread tasks longer than 50 ms. | Web clients only. |
| `<phase>.page.loafCount`, `loafBlockingMs` | Long animation frames and their blocking time. | Web clients only. |
| `<phase>.page.heapEndMB`, `domNodes` | JS heap in use at the end of the phase, and the DOM node count from CDP. | Web clients only. |
| `chat.firstStartMs` | Time to open the first chat on an idle client: type the prompt, click **Start**, and wait until the tab exists and the launcher has closed. | Includes typing at 5 ms per key. |
| `chat.startUnderLoadP50Ms`, `startUnderLoadMaxMs` | The same for the chats opened while other chats stream. | |
| `chat.switches`, `chatsOpen` | Chat switches done, and chat tabs open at the end of stream-storm. | Fewer than 8 open chats means a start failed. The `errors` array has the reason. |
| `probe.pacedRttP50Ms`, `P95Ms`, `MaxMs`, `pacedTimeouts` | Terminal reply round trip under the paced flood, across all terminals. | See [Terminal probe](#terminal-probe). |
| `probe.burstTotalMs`, `burstMBps` | Time from the first burst byte until the terminal answered the final probe, and the resulting throughput. | This is the terminal flood render time minus the final paint. |

### Process roles

For Chromium, `browser` is the root process. `renderer` is every page renderer, and `page-renderer` is the one renderer that used the most CPU over the run, which is the Termul page. Chromium also keeps a spare renderer and a `chrome-ui` renderer for its own UI. `gpu-process` rasterizes and composites. On a machine with no GPU, that work runs on the CPU through lavapipe or SwiftShader. `network`, `utility`, and `zygote` are the rest of the tree.

### Terminal probe

`terminal-probe.ts` runs inside the terminal through the real PTY path. It sends a cursor position request (`CSI 6n`). A terminal emulator answers the request only after it has parsed every byte written before it. The answer travels back over the client's input path: xterm.js `onData`, the WebSocket, the server, and the PTY. So the reply time means "the client processed all output and replied". The method works the same way for xterm.js and for a GPUIX terminal, and it needs no access to the canvas.

## Point the runner at the GPUIX client

The scenarios call only the `ClientDriver` interface in `clients/client.ts`: `waitForProjectList`, `waitForLauncher`, `startChat`, `chatCount`, `switchToChat`, `openTerminal`, `runInTerminal`, and the phase hooks. To add the GPUIX lane:

1. Add `clients/gpuix.ts`. Start the GPUIX app with `@gpuix/react/automation` `launch()` on the run's display, with `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`. Give it the relay URL (`proxy.url`) as its server origin and `PERF_TOKEN` as its token. Return a `ClientHandle` whose `rootPid` is the app process. Implement the driver methods with the automation API's wait, click, and type calls on the same labels that the Chromium driver uses: `Project: perf-project`, `Start agent chat`, `New chat`, the chat card title, `New tab`, and `Bash`.
2. Return `null` from `endPhase` until the GPUIX client exposes frame timing. When it does, map its frame intervals into `PageMetrics.frames`, so the `page.frame*` keys line up.
3. Add a `--client gpuix` branch next to `launchChromium` in `run.ts`, with a role function that names the app process `app`.

Then run the same command with `--client gpuix` and compare the two `aggregate.json` files with `bun run perf:report chromium=<dir> gpuix=<dir>`. These keys do not depend on the client and form the comparison set:

- `startup.projectListMs` and `startup.launcherReadyMs`
- `<phase>.proc.total.pssMedianMB` and `<phase>.proc.total.cpuMeanPct`
- `<phase>.bytesDownKBps`
- the `chat.*` keys
- the `probe.*` keys

For a like-for-like comparison, run Chromium with `--gl lavapipe`. Then both clients rasterize with the same Mesa Vulkan driver.
