# Linux performance baseline of the current client

This page records how the current Termul client performs on the GPUIX development machine under the `tools/perf` load scenarios. Later GPUIX runs on the same machine compare against these numbers. [`README.md`](README.md) describes the runners, every metric key, and how to point them at the GPUIX client.

## Verdict

On this machine the web client does not keep up with eight streaming chats. With 8 chats at 20 updates per second each, the page draws a median of 2 frames per second, main-thread long tasks fill about 90% of wall time, and a new chat takes 12 s to 15 s to open. The renderer's main thread is the limiter. With three terminals at 200 lines per second each, the page draws about 20 frames per second. There the limiter is software rasterization in Chromium's GPU process, not JavaScript. At idle, the shipped Linux app (Tauri on WebKitGTK) uses about the same memory as Chromium (563 MB against 541 MB PSS), but it keeps 92% of a core busy where Chromium uses 8%.

## Result sets

| Directory | Client | Runs | Use it for |
|---|---|---|---|
| [`baseline/chromium-proc/`](baseline/chromium-proc/) | Web client in Chromium, page observers off (`--page-metrics off`) | 3 per scenario: `idle`, `stream-storm`, `pty-flood` | Startup times, memory, CPU, bytes, chat starts, and terminal probes. Compare GPUIX against this set. |
| [`baseline/chromium-page/`](baseline/chromium-page/) | Web client in Chromium, page observers on | 5 per scenario: `stream-storm`, `pty-flood` | Frame pacing, long tasks, JS heap, and DOM size. |
| [`baseline/chromium-idle-page/`](baseline/chromium-idle-page/) | Web client in Chromium, page observers on | 5, `idle` | Evidence of what the observers cost at idle. |
| [`baseline/webkitgtk/`](baseline/webkitgtk/) | Shipped desktop app, Tauri on WebKitGTK | 5 | Startup and idle cost of the app that Linux users run. Includes one PNG per run. |

The page observers (`tools/perf/metrics/page-observers.ts`) run a `requestAnimationFrame` loop that keeps the page drawing. At idle they raised client CPU from 7.9% to 34.3% of a core and kept the page at 47 frames per second. Under pty-flood they added about 60% of a core, mostly in the GPU process. So process numbers come from the set with observers off, and page numbers come from the set with observers on.

## Setup

| Item | Value |
|---|---|
| Machine | 8 vCPU AMD EPYC (KVM guest, 2.0 GHz), 23 GiB RAM, Linux 6.8.0-147, no GPU |
| Web client | Built from this branch with `bun run build:web` (renderer unchanged since `9c9ddfdd`), served from `dist-web/` by Playwright routing |
| Browser | Playwright Chromium 153.0.8010.12, headed on Xvfb at 1440x900, dark color scheme |
| Rasterizer | `--gl lavapipe`: ANGLE on Vulkan, `llvmpipe (LLVM 20.1.2 256 bits)`. This is the Mesa driver that the GPUIX lane renders with. |
| Server | `/root/gpuix-bin/termul-server` (release build of Oct 20), loopback with a bearer token, fresh state per run |
| Desktop app | `termul-manager` release build of this branch with `tauri.conf.dev.json`, WebKitGTK 2.52.6-0ubuntu0.24.04.1, window 1200x800 on a 1440x900 Xvfb screen |
| Load | `tools/perf/fake-agent/fake-agent.ts`, seed 42, 20 updates per second per chat, 120-character chunks. The `tools/perf/fake-agent/flood.ts` line mix for terminals. |
| Errors | All 29 runs finished with no errors. Every stream-storm run opened 8 chats. No terminal probe timed out. |

Commands, from `apps/gpuix`:

```bash
bun run perf --scenarios idle,stream-storm,pty-flood --runs 3 --page-metrics off --quiet-wait 120 --out tools/perf/baseline/chromium-proc
bun run perf --scenarios stream-storm,pty-flood --runs 5 --quiet-wait 180 --out tools/perf/baseline/chromium-page
bun run perf --scenarios idle --runs 5 --quiet-wait 120 --out tools/perf/baseline/chromium-idle-page
bun tools/perf/webkit-startup.ts --runs 5 --out tools/perf/baseline/webkitgtk
bun run perf:report proc=tools/perf/baseline/chromium-proc page=tools/perf/baseline/chromium-page
```

## Results

Each cell is the median, with the minimum and maximum in parentheses. Chromium process and startup numbers are from `chromium-proc` (3 runs). Page numbers are from `chromium-page` (5 runs).

### Startup and idle

| Metric | Chromium | WebKitGTK desktop app |
|---|---|---|
| Time to first project list (`startup.projectListMs`, `projectListMs`) | 3179 ms (3027 to 4492) | 8588 ms (6300 to 10230) |
| Time to interactive launcher (`startup.launcherReadyMs`) | 3372 ms (3183 to 4586) | not measured |
| Browser process tree up (`startup.processUpMs`) | 1410 ms (805 to 1627) | first paint 513 ms (319 to 743) |
| Idle PSS of the client (`measure.proc.total.pssMedianMB`, `idle.proc.total.pssMedianMB`) | 541 MB (541 to 541) | 563 MB (555 to 587) |
| Idle RSS sum of the client | 1209 MB (1209 to 1209) | 749 MB (741 to 773) |
| Idle PSS of the page process (Chromium `page-renderer`, WebKit `web-process`) | 101 MB (101 to 102) | 397 MB (391 to 422) |
| Idle CPU of the client (`cpuMeanPct`) | 7.9% of one core (3.1 to 9.5) | 92.5% (80.4 to 104.7) |
| Idle CPU of the page process | 2.2% (1.4 to 3.2) | 56.1% (44.7 to 62.8) |

The Chromium idle numbers are from the `idle` scenario: 20 s to settle after the launcher is ready, then 20 s measured. The WebKitGTK numbers are from the same two windows after the project list shows. In the WebKitGTK app, the `other` role (agent `--version` checks and `npm` that the app starts) adds 31.6% of the 92.5%.

### stream-storm: 4 agents × 2 sessions = 8 streaming chats

| Metric | Value |
|---|---|
| First chat start on an idle client (`chat.firstStartMs`) | 4866 ms (3545 to 5605) |
| Chat start while others stream, median (`chat.startUnderLoadP50Ms`) | 15020 ms (9601 to 16014) |
| Chat start while others stream, slowest (`chat.startUnderLoadMaxMs`) | 21454 ms (15347 to 23565) |
| Chat switches done in the 30 s window (`chat.switches`) | 3 (2 to 3) |
| Client PSS, measure phase (`measure.proc.total.pssMedianMB`) | 1469 MB (1243 to 1534) |
| Client RSS sum, measure phase | 2149 MB (1923 to 2241) |
| Page renderer PSS, measure phase | 879 MB (679 to 995) |
| GPU process PSS, measure phase | 273 MB (258 to 295) |
| Client CPU, measure phase (`measure.proc.total.cpuMeanPct`) | 236% of one core (222 to 256) |
| Page renderer CPU | 117% (98 to 126) |
| GPU process CPU | 114% (113 to 121) |
| Bytes from the server (`measure.bytesDownKBps`) | 94 KB/s (86 to 119) |
| Server and agent CPU (`measure.server.cpuMeanPct`) | 47% (28 to 48) |
| Frame rate, measure phase (`measure.page.fps`, page set) | 2.0 fps (1.5 to 3.2) |
| Frame interval p50 and p95 (page set) | 383 ms (267 to 617) and 1267 ms (733 to 2300) |
| Long-task time per second (`measure.page.longtaskMsPerSec`, page set) | 903 ms (706 to 1016) |
| JS heap at the end of the phase (page set) | 191 MB (142 to 393) |
| DOM nodes at the end of the phase (page set) | 183746 (99620 to 273284) |

### pty-flood: 3 terminals × 200 lines per second

| Metric | Value |
|---|---|
| Client PSS, measure phase | 762 MB (755 to 790) |
| Client RSS sum, measure phase | 1457 MB (1456 to 1470) |
| Page renderer PSS | 259 MB (254 to 272) |
| GPU process PSS | 221 MB (212 to 228) |
| Client CPU, measure phase | 211% (196 to 221) |
| Page renderer CPU | 38% (38 to 46) |
| GPU process CPU | 144% (140 to 163) |
| Bytes from the server | 290 KB/s (287 to 296) |
| Server, shell, and probe CPU | 49% (47 to 68) |
| Terminal reply round trip under flood, p50 (`probe.pacedRttP50Ms`) | 91 ms (71 to 94) |
| Terminal reply round trip under flood, p95 | 514 ms (322 to 602) |
| Probe timeouts | 0 of 173 to 174 probes per run, across the 3 terminals |
| Burst of 20000 lines (2.66 MB) to final reply (`probe.burstTotalMs`) | 828 ms (826 to 1041) |
| Burst throughput (`probe.burstMBps`) | 3.21 MB/s (2.56 to 3.22) |
| Frame rate, measure phase (page set) | 19.9 fps (15.3 to 23.3) |
| Frame interval p95 (page set) | 150 ms (133 to 200) |
| Long-task time per second (page set) | 72 ms (31 to 108) |

## Limiters

Separate, unreported runs sampled per-thread CPU from `/proc/<pid>/task/*/stat` over 15 s to 20 s windows.

- **stream-storm.** The page renderer's main thread (`chrome`) used 80% to 81% of one core in the sustained and measure phases. The GPU process spread about 1.2 cores over its eight `llvmpipe` threads, and its main thread used 15%. Long tasks covered 70% to 100% of wall time. The main thread runs JavaScript and layout nearly all the time and cannot schedule frames, so it is the first limit. The 20% of the core that the main thread did not use is most likely time waiting for the GPU process or for a free core. That cause is a guess.
- **pty-flood.** The renderer main thread used 35% to 49% of one core. The GPU process used about 1.4 cores in `llvmpipe` threads, plus 30% in its main thread and 11% in `WSI swapchain`. Long tasks covered under 11% of wall time. The terminal canvas is rasterized on the CPU, so rasterization limits the frame rate, not JavaScript.
- **WebKitGTK at idle.** 32 s after launch, `WebKitWebProcess` used about 40% of a core: 10% in its threaded compositor, about 25% in `llvmpipe` threads, and 5% in its main thread. So WebKitGTK keeps compositing frames with software GL while the page looks still. Chromium does not, at 2.2% for its page renderer. Which page content keeps WebKit drawing is not known. Finding it is a follow-up.

## What each number measures, and its limits

- **Chromium is a stand-in for the web view.** The shipped desktop app renders with WebKitGTK on Linux and WebView2 on Windows. The Chromium numbers describe the same web client with a different process model, JavaScript engine, and compositor. The Linux desktop app was measured only for startup and idle, because WebKitGTK has no automation hook on this machine (`WebKitWebDriver` is not installed). The desktop app also talks to its Rust core over Tauri IPC instead of `termul-server`, so its startup includes work that the server does for the web client.
- **There is no GPU.** All rasterization runs on the CPU through lavapipe or llvmpipe. A machine with a GPU moves the pty-flood limiter and the WebKitGTK idle cost, and probably raises the terminal frame rate a lot. The stream-storm limiter is JavaScript on the main thread, so a GPU changes it less. These are inferences from the thread profiles, not measurements.
- **The machine was shared.** Other units ran builds, screenshots, and benchmarks on the same 8 cores. The quiet gate measured a 5 s sample of whole-machine CPU between 40% and 144% of one core before each run. During the measure phases, CPU used by neither the client nor the server (`machine.foreignCpuPct`) had medians from 0% to 215% depending on the set, and single runs up to 242%. The `chromium-proc` set ran during heavier foreign load than `chromium-page`, which likely explains why its chat starts and probe round trips are slower even though it does less work. Latency and frame numbers carry this noise. Memory numbers are steady across runs.
- **The sets ran one after another, not interleaved.** Within a set, scenarios alternate run by run. The WebKitGTK runs came after the Chromium runs.
- **Startup times are wall time from launch.** For Chromium they include Playwright starting the browser. For WebKitGTK they include `ffmpeg` grabbing the screen about every 100 ms, which costs CPU while the app starts, and a fresh `HOME`, so WebKit caches are cold. Chromium also starts with a fresh profile. The web client's JS bundle comes from disk through Playwright routing, so no network time is included.
- **Readiness differs by client.** Chromium waits for the sidebar row through the DOM. WebKitGTK waits for 100 pixels of the project avatar color in the sidebar, so it counts the frame that reached the screen.
- **Memory grows with stream time.** The stream-storm measure phase starts 2 to 3 minutes into the run, after all 8 chats opened. The chat open phase is longer when the client is slower (64 s to 115 s here). DOM nodes, JS heap, and page renderer PSS keep growing while chats stream, so they depend on how long the chats streamed. Compare them only between runs with the same flags.
- **RSS sums overstate a multi-process client.** RSS counts a shared page once in every process that maps it. PSS divides shared pages between those processes, so `proc.total.pss*` is the total to compare across clients.
- **Long-task time per second can pass 1000 ms.** A long task that started before the phase window is counted whole.
- **Frame rate counts `requestAnimationFrame` callbacks.** It shows how often the page could run a frame, not how often pixels reached the screen.
- **The terminal probe times the input and output path.** `CSI 6n` returns after xterm.js has parsed all output before it, and the reply crosses the WebSocket, the server, and the PTY. It does not include the final paint. The paced flood rate is fixed, so its round trip shows how far behind the client falls, not throughput. The burst number is throughput.
- **All chats stream the same content.** Every chat runs its own agent process with the same seed and session counter, so the content is the same in every chat. Each chat still renders its own copy.

## Compare a GPUIX client

Run the `chromium-proc` command with `--client gpuix`, once the GPUIX driver exists, and print both columns with `bun run perf:report chromium=tools/perf/baseline/chromium-proc gpuix=<dir>`. Compare the keys that do not depend on the client: `startup.projectListMs`, `startup.launcherReadyMs`, `proc.total.pssMedianMB`, `proc.total.cpuMeanPct`, `bytesDownKBps`, `chat.*`, and `probe.*`. Run both sides on the same day with the same flags, and interleave them, because other units share the machine.
