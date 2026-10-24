# GPUIX client against today's clients under the same load

This page compares the GPUIX desktop client with the web client in Chromium, and with the shipped Linux app (Tauri on WebKitGTK), under the `tools/perf` scenarios on the GPUIX development machine. [`baseline-linux.md`](baseline-linux.md) has the earlier Chromium-only baseline, and [`README.md`](README.md) describes the runner and every metric key.

## Verdict

On this machine, compared with today's desktop app, the GPUIX client starts faster and uses far less memory, but it is not yet faster to use under heavy load, and it crashes when many chats stream. It lists your project in about 2.3 s instead of 7.7 s for the shipped Linux app (3.6 s for the web client in Chromium). It sits idle at 232 MB and 9% of one CPU core, where the shipped app uses 543 MB and 94%. With one chat streaming it draws about twice as many frames as Chromium with 40% of the memory. With three busy terminals it uses half of Chromium's memory and the same CPU, but it shows a third as many frames per second. With 8 streaming chats it slows to under one frame per second, takes about 1.5 s per typed key, and crashed in 4 of 5 runs because of a 2 s timeout in the chat transcript's scroll polling. Most of the drawing cost on this machine is software rendering with no GPU. A real GPU would likely remove much of GPUIX's terminal and one-chat CPU cost, but not the many-chat slowdown, which is UI-thread layout work. So today a user would notice faster startup and lower memory, and under a heavy chat load they would notice a slower and less stable app. The crash fix and the UI-thread layout cost come first.


## Results

Each cell is the median of the runs, with the minimum and maximum in parentheses. `p` is the two-sided Mann-Whitney rank-sum p over the runs of both clients (`runs-report.ts`). With 5 runs a side, 0.008 is the smallest possible p and means every GPUIX run beat, or lost to, every Chromium run. A p above about 0.1 means no measurable difference at this run count.

### Startup and idle

Startup happens at the start of every run, so its rows pool all 15 runs per client.

| Metric | GPUIX | Chromium | p |
|---|---|---|---|
| Time to first project list (`startup.projectListMs`) | 2279 ms (1532 to 11192) | 3641 ms (2852 to 8952) | < 0.001 |
| Time to interactive launcher (`startup.launcherReadyMs`) | 4036 ms (2935 to 14020) | 3997 ms (3039 to 10017) | 0.74 |
| Process up (`startup.processUpMs`) | 1223 ms (806 to 9261) | 1248 ms (944 to 4450) | |
| Idle PSS of the client (`measure.proc.total.pssMedianMB`) | 232 MB (224 to 236) | 536 MB (532 to 540) | 0.008 |
| Idle RSS sum of the client | 281 MB (277 to 283) | 1199 MB (1193 to 1205) | |
| Idle CPU of the client (`measure.proc.total.cpuMeanPct`) | 8.8% of one core (6.2 to 10.7) | 6.6% (3.1 to 9.5) | 0.22 |
| Frames on screen while idle (`measure.screen.fps`) | 0 | 0 | |

The shipped Linux app ran after the Chromium and GPUIX sets, 5 runs, through `webkit-startup.ts`. It is not interleaved with the other two, and it measures only startup and idle (see [`baseline-linux.md`](baseline-linux.md#measure-the-shipped-linux-app)).

| Metric | GPUIX | Shipped app (WebKitGTK) |
|---|---|---|
| Time to first project list | 2279 ms (1532 to 11192), 15 runs | 7695 ms (7002 to 12253), 5 runs |
| Idle PSS of the client | 232 MB (224 to 236) | 543 MB (489 to 560) |
| Idle RSS sum of the client | 281 MB (277 to 283) | 744 MB (738 to 749) |
| Idle CPU of the client | 8.8% of one core (6.2 to 10.7) | 94.4% (83.6 to 102.8) |

The two startup numbers are measured differently. WebKitGTK's counts the first screen grab with the project avatar's color in the sidebar, at a 1200x800 window. GPUIX's counts the project row's element in the automation tree, at 1440x900. WebKitGTK's idle CPU includes 28.8% in the `other` role, the agent `--version` checks and `npm` that the desktop app starts, which the GPUIX client leaves to the server.

GPUIX lists the project about 1.4 s sooner, but the launcher accepts input at the same time as in Chromium. The GPUIX gap between the two is the agent picker and composer mounting after the shell. At idle GPUIX uses 43% of Chromium's memory. Idle CPU is the same within noise: GPUIX's comes from the Bun thread (4.9%) and the GPUI UI thread (1.4%), and neither client draws a frame while idle.

### pty-flood: 3 terminals at 200 lines per second each, then a 20000-line burst

All 5 runs per client finished with no errors and no probe timeouts.

| Metric | GPUIX | Chromium | p |
|---|---|---|---|
| Frames on screen, measure phase (`measure.screen.fps`) | 5.7 fps (3.7 to 7.3) | 17.7 fps (13.8 to 25.4) | 0.008 |
| Gap between frames, p50 and p95 | 143 ms and 357 ms | 30 ms and 171 ms | 0.008 (p95) |
| Frames on screen during the burst (`burst.screen.fps`) | 5.0 fps (2.6 to 8.5) | 23.0 fps (19.4 to 34.0) | 0.008 |
| Client PSS, measure phase | 388 MB (339 to 401) | 758 MB (746 to 774) | 0.008 |
| Client RSS sum, measure phase | 441 MB (424 to 454) | 1439 MB (1428 to 1448) | |
| Client CPU, measure phase | 253% of one core (207 to 303) | 262% (234 to 297) | 0.84 |
| Terminal reply round trip under flood, p50 (`probe.pacedRttP50Ms`) | 90 ms (62 to 346) | 64 ms (58 to 96) | 0.22 |
| Terminal reply round trip under flood, p95 | 642 ms (420 to 1351) | 463 ms (274 to 839) | 0.22 |
| Burst of 2.66 MB to final reply (`probe.burstMBps`) | 1.83 MB/s (0.99 to 6.79) | 2.16 MB/s (2.02 to 2.76) | 0.69 |
| Bytes from the server, measure phase | 291 KB/s (281 to 296) | 290 KB/s (274 to 297) | |

GPUIX uses half the memory and the same CPU, but it puts a third as many frames on the screen. Reply round trips and burst throughput show no measurable difference at 5 runs. GPUIX's spread is wide: two GPUIX bursts reached 6.2 and 6.8 MB/s, and two fell under 1.6 MB/s.

### stream-storm: 4 agents x 2 sessions = 8 streaming chats

Chromium finished all 5 runs with 8 chats open and no errors. GPUIX crashed in 4 of 5 runs (see [Product bugs](#product-bugs)), so most GPUIX rows have one run. The warmup rows come from the first 10 s with one streaming chat, before any crash, so they use all 5 GPUIX runs.

| Metric | GPUIX | Chromium | p |
|---|---|---|---|
| Runs that finished | 1 of 5 | 5 of 5 | |
| First chat start on an idle client (`chat.firstStartMs`) | 5415 ms (3792 to 5638), 5 runs | 5211 ms (3316 to 5671) | 0.84 |
| One streaming chat: frames on screen (`warmup.screen.fps`) | 8.1 fps (6.8 to 9.3), 5 runs | 4.7 fps (3.3 to 5.9) | 0.008 |
| One streaming chat: client PSS | 279 MB (239 to 287), 5 runs | 698 MB (694 to 724) | 0.008 |
| One streaming chat: client CPU | 329% of one core (282 to 351), 5 runs | 235% (183 to 256) | 0.008 |
| Chat start while others stream, median (`chat.startUnderLoadP50Ms`) | 33693 ms, 1 run | 10550 ms (5413 to 17801) | |
| Typing part of that start (`chat.typeUnderLoadP50Ms`) | 23376 ms, 1 run | 6555 ms (1700 to 12084) | |
| Start click to open chat (`chat.openUnderLoadP50Ms`) | 4492 ms, 1 run | 2406 ms (2113 to 2834) | |
| Slowest chat start (`chat.startUnderLoadMaxMs`) | 89484 ms, 1 run | 20463 ms (14454 to 25484) | |
| Frames on screen while switching chats (`sustained-stream.screen.fps`) | 0.8 fps, 1 run | 9.9 fps (7.8 to 11.4) | |
| Frames on screen, measure phase | 0.8 fps, 1 run | 5.8 fps (3.5 to 10.2) | |
| Client PSS, measure phase | 913 MB, 1 run | 1360 MB (1179 to 1493) | |
| Client CPU, measure phase | 118% of one core, 1 run | 254% (188 to 295) | |
| Bytes from the server, measure phase | 48 KB/s, 1 run | 88 KB/s (83 to 108) | |

With one chat streaming, GPUIX draws more frames than Chromium with 40% of the memory, at more CPU. Each chat that GPUIX adds makes it slower. GPUIX chat starts grow from 4 s to 6 s for the first chat, to 12 s to 20 s for chats 2 and 3, and to 30 s to 91 s for chats 5 to 8. Chromium's chats 5 to 8 took 5 s to 25 s. With 8 chats open, GPUIX draws under one frame per second and takes about 1.5 s for each typed key.

### stream-storm with 4 chats (`--agents 2`)

This extra set ran right after the main set with the same flags except `--agents 2`, 5 interleaved runs per client. It checks whether GPUIX holds up at a lighter load. GPUIX finished 2 of 5 runs. The other 3 crashed the same way. In 3 of the 5 GPUIX runs the fourth chat never took its prompt ("launcher composer never accepted"), so one finished GPUIX run had 3 chats open, not 4.

| Metric | GPUIX | Chromium | p |
|---|---|---|---|
| Runs that finished | 2 of 5 | 5 of 5 | |
| One streaming chat: frames on screen | 8.1 fps (5.3 to 9.0), 5 runs | 3.8 fps (3.7 to 5.3) | 0.016 |
| One streaming chat: client PSS | 267 MB (221 to 281), 5 runs | 695 MB (680 to 728) | 0.008 |
| One streaming chat: client CPU | 322% of one core (224 to 337), 5 runs | 168% (144 to 209) | 0.008 |
| Chat start while others stream, median | 17116 ms and 19140 ms | 12066 ms (8884 to 13299) | 0.095 |
| Typing part of that start | 11613 ms and 13697 ms | 7681 ms (5230 to 9471) | 0.095 |
| Start click to open chat | 2174 ms and 2568 ms | 2526 ms (1741 to 3210) | 0.86 |
| Frames on screen while switching chats | 2.1 and 2.8 fps | 3.8 fps (3.6 to 5.8) | 0.095 |
| Frames on screen, measure phase | 2.0 and 3.0 fps | 3.1 fps (1.9 to 3.6) | 0.48 |
| Client PSS, measure phase | 454 MB and 861 MB | 1066 MB (1047 to 1076) | 0.095 |
| Client CPU, measure phase | 154% and 202% of one core | 212% (162 to 266) | 0.38 |

At 4 chats, the runs that finished show GPUIX drawing about as many frames as Chromium with less memory. Typing a prompt is slower on GPUIX. With 2 finished runs, none of these differences reaches p < 0.05.

## Limiters

Per-thread CPU in the measure phase, median over the runs that finished (`runs-report.ts`), in percent of one core.

| Scenario | GPUIX | Chromium |
|---|---|---|
| idle | `bun` 4.9, `gpuix-ui` 1.4 | page renderer `ThreadPoolForeg` 1.5, page renderer main 0.7 |
| pty-flood | `llvmpipe-N` 187, `gpuix-ui` 29, `bun` 24, `WSI swapchain` 5 | GPU process `llvmpipe-N` 130, GPU main 36, page renderer main 31, `WSI swapchain` 11 |
| stream-storm, 8 chats | `gpuix-ui` 90, `llvmpipe-N` 22, `bun` 4 (1 run) | GPU process `llvmpipe-N` 104, page renderer main 74, GPU main 20, page renderer `ThreadPoolForeg` 19 |
| stream-storm, warmup (1 chat, all 5 runs) | `llvmpipe-N` 250, `gpuix-ui` 34, `bun` 20, `JITWorker` 15 | GPU process `llvmpipe-N` 105, page renderer main 38, GPU main 30, page renderer `ThreadPoolForeg` 22 |

- **GPUIX under pty-flood is bound by software rasterization.** Its lavapipe threads use about 1.9 cores. Its UI thread (29%) and JS thread (24%) have room. Per frame on screen, GPUIX spends about 330 ms of lavapipe CPU (187% / 5.7 fps) where Chromium spends about 73 ms (130% / 17.7 fps). Why GPUIX's frames cost so much more lavapipe time is not measured. A separate, unreported run logged X damage rectangles while a terminal printed output. Every present of both clients covered the whole window (98 of 98 GPUIX frames, 349 of 349 Chromium frames), so X damage cannot show how much each client re-rasterizes. My guess is that GPUI redraws the whole scene each frame and Chromium re-rasterizes only changed tiles.
- **With one streaming chat, GPUIX is also bound by software rasterization.** Its lavapipe threads use 2.5 cores for 8 frames per second, against Chromium's 1 core for 4.7. GPUIX draws more frames there because its UI thread still has room.
- **GPUIX under stream-storm is bound by its UI thread.** `gpuix-ui` sits at 83% to 90% of one core with 6 to 8 chats open, and the JS thread under 10%. A separate, unreported `perf record` of `gpuix-ui` with 4 chats streaming put 70% of samples in `gpuix-native.linux-x64-gnu.node`. The top symbols were Taffy flexbox and block layout (about 25% together), `malloc` and `free` (about 15%), element id hashing, `gpuix_native::renderer::build_element`, and text shaping. The automation tree held 2146 elements, of which 330 had on-screen bounds, so the hidden chat panes stay mounted. Whether GPUI rebuilds and lays out the hidden panes on every frame is not proven. It is the first thing to check. Frame rate falls as transcripts grow (7 to 9 fps with one chat, 1.5 fps while chats open, 0.8 fps with 8 chats), so the per-frame work grows with the content.
- **Chromium under both loads** is bound by the GPU process's lavapipe threads plus the page renderer's main thread, as in [`baseline-linux.md`](baseline-linux.md#limiters).

## Product bugs

### The GPUIX app crashes under streaming load (4 of 5 runs at 8 chats)

The whole window is replaced by the runtime-error overlay:

```text
Uncaught runtime errors:
Timed out after 2 seconds waiting for the GPUI list scroll query
    at getListScrollTop (unknown)
    at <anonymous> (apps/gpuix/src/overrides/components/chat/ChatMessageList.tsx:233:28)
uncaughtException
```

Cause, from the code. `useListFollow` in `src/overrides/components/chat/ChatMessageList.tsx` calls `renderer.getListScrollTop(id)` every 120 ms (`FOLLOW_POLL_MS`) from a `setInterval`, once for every mounted transcript. Hidden chat panes stay mounted (the tree keeps one composer per open chat), so this likely polls hidden chats too. That part is inferred, not measured. That native call sends a command to the GPUI UI thread and waits for the answer with a fixed 2 s timeout (`recv_ui_response` in GPUIX `packages/native/src/renderer.rs`). When the UI thread is busy for more than 2 s, the call throws inside the interval callback. Nothing catches it, so the error becomes an `uncaughtException` and the error boundary replaces the app. The same 2 s limit also blocks the JS thread for up to 2 s on every poll while the UI thread is busy.

Repro, from `apps/gpuix` on this machine:

```bash
bun run build
bun run perf --client gpuix --scenarios stream-storm --runs 1 --page-metrics off \
  --state-root /tmp/gpuix-f2/repro --out /tmp/gpuix-f2/repro-out
```

The run ends with `fatal: app crashed: Timed out after 2 seconds waiting for the GPUI list scroll query`. The crash came while chats 4 to 8 were opening or during chat switches. It also crashed in 1 of the 4-chat runs, which started with a load average of 10.7 from other agents.

Suggested fix: catch the timeout in `read()` and keep the last follow state, then stop polling hidden transcripts. Better still, have the native side push scroll changes, so JS never blocks on the UI thread.

### Typing and clicks wait seconds under load

Every key and click goes through the same GPUI UI thread queue. With 3 chats streaming in the background, the launcher open, and no transcript on screen, single keys took 176 ms to 868 ms to land, growing over the 25 keys (separate, unreported run). With 6 to 8 chats it was about 1.5 s per key. This is the UI-thread limiter above as a user sees it.

### Measured data the driver could not explain

In the one GPUIX 8-chat run that finished, the client received 48 KB/s from the server, against 83 to 108 KB/s for Chromium with the same 8 chats. Bytes per chat are not steady even for Chromium: 5.5 to 6.0 KB/s per chat with 4 chats, and 10.4 to 13.5 with 8 chats. So the stream carries more than the chat deltas, and that part grows faster than the chat count. In the 4-chat set, GPUIX received 5.7 and 9.5 KB/s per chat. Whether the GPUIX shell subscribes to fewer updates, or falls behind on reading them, is not established.


## Method

| Item | Value |
|---|---|
| Machine | 8 vCPU AMD EPYC (KVM guest), 23 GiB RAM, Linux 6.8.0-147, no GPU. Other agents ran builds and benchmarks on the same cores during every run. |
| GPUIX client | Production bundle `apps/gpuix/dist/main.js` (`bun run build`, `NODE_ENV=production`) of branch `gpuix/f2`, which has the app code of `exp/gpuix-client` at `eceaec17`. GPUIX 0.11.0 on Bun 1.4.0. GPUI renders with Vulkan on Mesa lavapipe; each run reads the loaded driver from `/proc/<pid>/maps` (`libvulkan_lvp.so` in every run). |
| Web client | `dist-web/` of the same worktree, built after the last renderer commit, in Playwright Chromium 153 (`chromium-1243`), headed. `--gl lavapipe` makes Chromium rasterize through ANGLE on the same lavapipe driver. |
| Shipped app | `termul-manager` release build with `tauri.conf.dev.json` (WebKitGTK 2.52.6), startup and idle only, through `webkit-startup.ts`. |
| Server | `/root/gpuix-bin/termul-server` (release build of Oct 20) on port 8196, behind the byte-counting relay on 8197, with fresh state under `/tmp/gpuix-f2/state/` for every run. |
| Display | A fresh Xvfb `:181` at 1440x900 for every run. The GPUIX window and the Chromium window both fill the screen. |
| Load | The fake ACP agent, seed 42, 20 updates per second per chat, 120-character chunks. The terminal line mix of `tools/perf/fake-agent/flood.ts`. |

Command, from `apps/gpuix`:

```bash
bun run perf --client gpuix,chromium --scenarios idle,stream-storm,pty-flood --runs 5 \
  --page-metrics off --state-root /tmp/gpuix-f2/state --out <dir> --quiet-wait 300
bun run perf:report gpuix=<dir>/gpuix chromium=<dir>/chromium
bun tools/perf/runs-report.ts <dir> measure sustained-stream flood burst
```

The 4-chat set and the shipped app, from `apps/gpuix`:

```bash
bun run perf --client gpuix,chromium --scenarios stream-storm --runs 5 --agents 2 \
  --page-metrics off --state-root /tmp/gpuix-f2/state4 --out <dir4> --quiet-wait 300
bun tools/perf/webkit-startup.ts --runs 5 --state-root /tmp/gpuix-f2/webkit --out <dir-webkit> --quiet-wait 300
```

The result files of these runs are in [`results-f2/`](results-f2/): `main/` (the 3-scenario set), `storm4/` (the 4-chat set), and `webkitgtk/`. Each run file keeps its `procSeries`, so `report.ts` and `runs-report.ts` rerun on them as they are.

### How the runs are ordered

The runner interleaves. Run 1 does idle on GPUIX, then idle on Chromium, then stream-storm on GPUIX, then on Chromium, then pty-flood on both. Run 2 does the same with Chromium first, and so on. So drift and other agents' load fall on both clients alike. Before each run, the runner waits until a 5 s sample of whole-machine CPU is under 150% of one core, for at most 300 s. Each run record keeps that sample (`meta.preRunBusyPct`), the wait, and the 1-minute load average (`meta.load1Before`). The load table under [Load per run](#load-per-run) lists them.

### How each client is driven

Both drivers do what a user does, through the same `ClientDriver` interface (`clients/client.ts`).

- **Chromium** uses Playwright locators on the page's labels: the project row, **New chat**, the launcher composer, **Start**, the chat card, and the tab bar's **New tab** menu with **Bash**.
- **GPUIX** uses `@gpuix/react/automation`: `getTree` for the element tree with bounds, `mouse.click` at an element's center, and `keystrokes` into an element. The automation tree has test ids and text but no aria labels, so `clients/gpuix.ts` finds **New chat**, **Start**, and the status-bar **Terminal** button by their place in the tree. It opens terminals from the status bar, which runs the same terminal spawn as the tab bar's **Bash** entry.

Typing differs in one way. Playwright sends one key at a time and waits for the page to take each key. The GPUIX driver also sends one key per `keystrokes` command. The app's native side waits at most 2 s for the GPUI UI thread to take each command. When the UI thread is busier than that, the command stays in GPUI's ordered queue and lands later, so the driver keeps going instead of failing. The textarea does not expose its value to automation, so the driver treats "the placeholder went away" as "the text landed".

### What each metric measures, and whether the two sides compare

- **Memory.** PSS from `/proc/<pid>/smaps_rollup` and RSS from `/proc/<pid>/statm`, summed over the client's process tree every 500 ms. GPUIX is one process. Chromium is a browser, a GPU process, renderers, and helpers. PSS splits shared pages between processes, so `proc.total.pssMedianMB` compares one-to-one.
- **CPU.** `utime + stime` of the process tree from the same samples, in percent of one core. Comparable.
- **Per-thread CPU.** `/proc/<pid>/task/*/stat` read at the start and end of each phase (`thread-sampler.ts`). Reading `/proc` twice per phase costs the client nothing. Threads with the same name are summed, so `llvmpipe-N` is all lavapipe raster threads of a process.
- **Frames on screen.** `x-frames.py` asks the X server for a DAMAGE report on every top-level window and logs each one. Damage events less than 3 ms apart count as one frame. This counts presents that reached the X server, the same way for both clients, with nothing running inside either client. It is not the `requestAnimationFrame` cadence of `baseline-linux.md`, which counts how often the page could run a frame, so `screen.*` numbers are not comparable with the old `page.fps` numbers. The logger is its own process. Its cost lands on the X server and on the machine, not on either client's tree.
- **Chat start.** From the start of `startChat` until the chat card exists and the launcher has closed. `chat.typeUnderLoadP50Ms` is the typing part. `chat.openUnderLoadP50Ms` is the part from the **Start** click until the chat shows. Both sides type the same prompts.
- **Terminal reply round trip.** The in-PTY `CSI 6n` probe (`terminal-probe.ts`). A terminal answers only after it has parsed every byte before the request, and the answer crosses the client's input path, the WebSocket, the server, and the PTY. GPUIX's terminal and xterm.js both answer `CSI 6n`, so the probe measures the same thing on both sides.
- **Bytes.** Bytes through the relay per second. These show that both clients received the same stream.
- **Startup.** From the `launch()` call until the seeded project row exists (`projectListMs`) and until the launcher accepts input (`launcherReadyMs`). GPUIX checks for the element in the automation tree. Chromium checks the DOM. Neither waits for the pixels.

### Load per run

Other agents ran their own GPUIX apps, builds, and screenshots on the same 8 cores the whole time. `runs-report.ts` prints the full per-run table. In summary:

| Set | Client | Runs | Quiet-gate sample before the run | 1-minute load average | Gate wait | Foreign CPU in the measure phase, median and max |
|---|---|---|---|---|---|---|
| main | GPUIX | 15 | 33% to 143% of one core | 2.4 to 13.1 | 5 s to 105 s | 49% and 370% |
| main | Chromium | 15 | 36% to 149% | 2.5 to 10.3 | 5 s to 70 s | 58% and 243% |
| 4 chats | GPUIX | 5 | 35% to 146% | 5.5 to 10.7 | 5 s to 231 s | 123% and 123% (2 finished runs) |
| 4 chats | Chromium | 5 | 71% to 145% | 4.4 to 9.8 | 10 s to 135 s | 131% and 187% |
| shipped app | WebKitGTK | 5 | 33% to 143% | 6.5 to 8.7 | | not sampled |

The load average often stayed high while the 5 s CPU sample passed the gate, because other agents ran in bursts. Latency and frame numbers carry that noise on both sides. The GPUIX pty-flood run with the worst numbers (346 ms reply p50, 3.7 fps) started at a load average of 13.1.

## What the numbers mean, and their limits

- **Everything here is rendered in software.** The machine has no GPU. GPUIX rasterizes with lavapipe through Vulkan. Chromium rasterizes with ANGLE on the same lavapipe. The shipped app uses WebKitGTK's software GL. Every frame-rate number, and every CPU number in pty-flood and in the one-chat warmup, is bound by software rasterization on both sides. GPUI is built to draw on a GPU, so on a real GPU the lavapipe threads' 1.9 to 2.5 cores of work would move off the CPU. GPUIX's terminal frame rate and its one-chat CPU cost would then most likely improve much more than Chromium's, whose page renderer already does more of its work outside raster. That is an inference from the thread profiles, not a measurement.
- **The stream-storm limiter is not rasterization.** With 6 to 8 chats, GPUIX's UI thread is the limit at 83% to 90% of one core. It spends that time on layout and element building, not drawing, so a GPU would not fix it. Neither would a faster JS engine: the JS thread is under 10%.
- **The crash removes most GPUIX stream-storm data.** Rows marked "1 run" or "2 runs" come from the runs that survived, which may be the luckier ones. The warmup rows avoid that bias, because every run reached them.
- **The GPUIX driver costs the app something.** `getTree` serializes the whole element tree and asks the UI thread for every element's bounds. Under load each call took 260 ms to 850 ms in a separate run. The driver polls it every 250 ms while it waits for a step, so the observer competes with the app's own UI thread during chat starts and switches. Playwright's locator queries cost Chromium's renderer main thread too, but less. The measure phases send no driver calls on either side, so the measure rows are observer-free.
- **Typing is not a typing-speed test.** Both drivers send one key at a time and wait for the client to take it. A chat start's typing part therefore measures input latency under load, times the prompt length (13 to 16 characters plus Ctrl+A and Backspace).
- **Frames on screen are presents, not content changes.** Both clients present full-window images, so the frame counter cannot tell a frame that changed one character from one that changed everything. Neither client presents while idle.
- **Startup readiness is an element, not a pixel**, for both GPUIX and Chromium. A GPUIX element can exist in the tree a frame before it is painted.
- **The shipped app was measured after the other two, not interleaved,** at a different window size, with pixel-based readiness, and with Tauri IPC instead of `termul-server`.
- **Chromium is a stand-in for the shipped app's web view.** See [`baseline-linux.md`](baseline-linux.md#what-each-number-measures-and-its-limits).
- **Five runs a side is enough only for large differences.** A gap with p above 0.1 here is no measurable difference, not proof of equality.

