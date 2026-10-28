# GPUIX against today's clients at one head (M5)

This page repeats the whole-app comparison of [`gpuix-vs-baseline.md`](gpuix-vs-baseline.md) (F2) on `gpuix/m5`, which is `exp/gpuix-client` at c037d87e with every unit landed, and with GPUIX on the patched addon that the `.deb` ships. It replaces F2's numbers and the GPUIX rows of [`hidden-panes.md`](hidden-panes.md) (F3) and L1's `results-l1/storm8` records as the current state. [`README.md`](README.md) describes the runner and every metric key.

## Verdict

On this machine, with software rendering and no GPU, the GPUIX client now uses less than half the memory of the web client in Chromium in every scenario, survives the heavy chat load it used to crash under, answers terminal input faster, and opens a chat sooner under load. It does not draw more frames than Chromium except with 4 streaming chats, it uses more CPU under load, and its startup to an interactive launcher got slower since F2.

Against the shipped Linux app (Tauri on WebKitGTK), GPUIX lists the project in about 3.0 s instead of 7.8 s and idles at 241 MB and 14% of a core instead of 553 MB and 121%.

Regressions since earlier units, stated plainly:

- **Startup got slower.** On the same host, server and addon, the head bundle lists the project 1.1 s later and accepts input in the launcher 1.5 s later than F2's bundle (median 3.14 s against 2.06 s, and 5.25 s against 3.76 s; 5 runs each, p = 0.032). Chromium's startup did not move between F2 and M5 (3.64 to 3.71 s to the project list). The cause is not identified (see [Limiters](#limiters)).
- **Under load GPUIX uses more CPU than Chromium**: 282% of a core against 228% with 8 chats, 282% against 213% under the terminal flood. In F2 the 8-chat GPUIX run that survived used 118%, because its UI thread was saturated and it drew under one frame per second.
- **Memory with 8 chats rose from L1's 537 MB to 587 MB** (L1 3 runs, M5 5 runs; not tested for significance across days).

## Results

Each cell is the median of 5 runs, with the minimum and maximum in parentheses, unless it says otherwise. `p` is the two-sided Mann-Whitney rank-sum p over the runs of both clients (`runs-report.ts`). With 5 runs a side, 0.008 is the smallest possible p. A p above about 0.1 is no measurable difference at this run count, not proof of equality. Every run of every set finished with status ok and no errors: 15 GPUIX and 15 Chromium runs in the main set, 5 and 5 with 4 chats, 5 WebKitGTK runs, and 10 in the startup A/B. The records are in [`results-m5/`](results-m5/).

### Startup and idle

The startup rows pool all 15 runs per client of the main set, because every run starts the client. The idle rows come from the 5 idle runs.

| Metric | GPUIX | Chromium | p | Shipped app (WebKitGTK) |
|---|---|---|---|---|
| Time to first project list | 3033 ms (2117 to 6024) | 3711 ms (2518 to 8509) | 0.17 | 7765 ms (6812 to 9006) |
| Time to interactive launcher | 5436 ms (3779 to 9734) | 4021 ms (2615 to 8977) | 0.056 | not measured |
| Idle PSS of the client | 241 MB (240 to 242) | 538 MB (536 to 543) | 0.008 | 553 MB (547 to 554) |
| Idle RSS sum of the client | 291 MB (290 to 292) | 1200 MB (1191 to 1208) | | 738 MB (732 to 740) |
| Idle CPU of the client | 14.5% of one core (12.0 to 16.2) | 11.7% (10.4 to 16.7) | 0.31 | 121% (102 to 133) |

WebKitGTK ran after the other two, not interleaved, through `webkit-startup.ts`, which reads the project list from pixels at a 1440x900 window. Its idle CPU includes 32% in the `other` role (the agent version checks and `npm` the desktop app starts) and 77% in the web process.

Chromium presented 1.6 frames per second while idle (`measure.screen.fps`), where F2 recorded 0; GPUIX presented none. That was not traced.

**Startup A/B against F2's code.** `ab.ts` interleaved the F2-era bundle (`eceaec17`, built into `dist-sf2/`) and the head bundle, 5 idle runs each, on the same server, addon and host.

| Metric | F2 bundle | Head bundle | p |
|---|---|---|---|
| Time to first project list | 2057 ms (1355 to 2386) | 3141 ms (2279 to 3488) | 0.032 |
| Time to interactive launcher | 3762 ms (3311 to 4095) | 5251 ms (3941 to 6194) | 0.032 |
| Idle PSS | 230 MB (227 to 233) | 240 MB (240 to 242) | 0.008 |
| Idle CPU | 10.0% (9.6 to 15.8) | 9.6% (8.8 to 18.5) | 0.45 |

The head bundle used 167% of a core for 5.3 s of startup and the F2 bundle 184% for 3.8 s, so the head does about 27% more CPU work before the launcher is ready (8.9 against 7.0 core-seconds).

### pty-flood: 3 terminals at 200 lines per second each, then a 20000-line burst

| Metric | GPUIX | Chromium | p |
|---|---|---|---|
| Terminal reply round trip under flood, p50 | 58 ms (52 to 71) | 154 ms (89 to 178) | 0.008 |
| Terminal reply round trip under flood, p95 | 434 ms (373 to 484) | 751 ms (386 to 1729) | 0.095 |
| Burst of 2.66 MB to final reply | 4.76 MB/s (2.21 to 6.17) | 1.59 MB/s (1.21 to 3.77) | 0.095 |
| Frames on screen, measure phase | 5.9 fps (5.1 to 7.3) | 12.3 fps (8.4 to 22.4) | 0.008 |
| Frames on screen during the burst | 6.8 fps (4.0 to 10.6) | 21.3 fps (12.2 to 45.7) | 0.008 |
| Client PSS, measure phase | 391 MB (385 to 402) | 768 MB (761 to 769) | 0.008 |
| Client CPU, measure phase | 282% of one core (266 to 293) | 213% (205 to 254) | 0.008 |
| Bytes from the server, measure phase | 289 KB/s (287 to 295) | 287 KB/s (189 to 291) | |

GPUIX answers the terminal sooner and takes the burst faster at half the memory, and it shows fewer frames.

### stream-storm: 4 agents x 2 sessions = 8 streaming chats

| Metric | GPUIX | Chromium | p |
|---|---|---|---|
| Runs that finished with 8 chats open | 5 of 5 | 5 of 5 | |
| First chat start on an idle client | 5045 ms (3691 to 8696) | 5119 ms (3655 to 6063) | 1.0 |
| One streaming chat: frames on screen | 7.9 fps (7.3 to 8.7) | 4.6 fps (3.8 to 5.3) | 0.008 |
| One streaming chat: client PSS | 283 MB (263 to 285) | 696 MB (690 to 728) | 0.008 |
| One streaming chat: client CPU | 310% of one core (303 to 324) | 197% (174 to 198) | 0.008 |
| Chat start while others stream, median | 12660 ms (10320 to 13773) | 14560 ms (5569 to 20259) | 0.55 |
| Typing part of that start | 9229 ms (7793 to 10018) | 7927 ms (2294 to 10379) | 0.84 |
| Start click to open chat | 966 ms (785 to 1368) | 2612 ms (2139 to 5063) | 0.008 |
| Frames on screen while switching chats | 5.8 fps (4.5 to 7.1) | 10.1 fps (6.5 to 11.5) | 0.016 |
| Frames on screen, measure phase | 4.5 fps (3.4 to 7.3) | 3.9 fps (2.2 to 8.4) | 0.79 |
| Client PSS, measure phase | 587 MB (569 to 628) | 1416 MB (1350 to 1555) | 0.008 |
| Client CPU, measure phase | 282% of one core (260 to 291) | 228% (214 to 253) | 0.008 |

### stream-storm with 4 chats (`--agents 2`)

| Metric | GPUIX | Chromium | p |
|---|---|---|---|
| Runs that finished with 4 chats open | 5 of 5 | 5 of 5 | |
| One streaming chat: frames on screen | 7.0 fps (5.0 to 10.6) | 3.8 fps (3.4 to 5.2) | 0.016 |
| One streaming chat: client PSS | 281 MB (261 to 285) | 701 MB (677 to 705) | 0.008 |
| Chat start while others stream, median | 17777 ms (9160 to 20172) | 14225 ms (12707 to 26075) | 0.84 |
| Start click to open chat | 1557 ms (751 to 2053) | 2837 ms (1826 to 3942) | 0.016 |
| Frames on screen while switching chats | 4.4 fps (3.5 to 6.2) | 4.9 fps (2.8 to 6.6) | 1.0 |
| Frames on screen, measure phase | 4.8 fps (4.5 to 6.1) | 3.0 fps (1.5 to 3.9) | 0.008 |
| Client PSS, measure phase | 497 MB (480 to 520) | 1106 MB (1081 to 1125) | 0.008 |
| Client CPU, measure phase | 293% of one core (266 to 306) | 221% (208 to 242) | 0.008 |

## Against the earlier records

GPUIX medians. The runs were made on different days, at different loads, with different servers (F2 and L1 used the Oct 20 server, M5 a build of this head), so read these as direction, not tested differences.

| Metric | F2 (Oct 23) | F3 or L1 | M5 |
|---|---|---|---|
| 8 chats: runs that finished | 1 of 5 | L1 3 of 3 | 5 of 5 |
| 8 chats: chat start under load, median | 33.7 s (1 run) | L1 13.9 s | 12.7 s |
| 8 chats: frames on screen, measure | 0.8 fps (1 run) | L1 4.5 fps | 4.5 fps |
| 8 chats: client PSS, measure | 913 MB (1 run) | L1 537 MB | 587 MB |
| 4 chats: runs that finished | 2 of 5 | F3 5 of 5 (2 lost a start) | 5 of 5, none lost |
| 4 chats: frames on screen, measure | 1.3 and 1.4 fps | F3 4.6 fps | 4.8 fps |
| 4 chats: client PSS, measure | 439 and 492 MB | F3 898 MB | 497 MB |
| Time to first project list | 2279 ms | L1 4105 ms (3 runs) | 3033 ms |
| Time to interactive launcher | 4036 ms | L1 9683 ms (3 runs) | 5436 ms |
| Idle PSS and CPU | 232 MB, 8.8% | | 241 MB, 14.5% |
| pty-flood: reply p50, burst | 90 ms, 1.83 MB/s | | 58 ms, 4.76 MB/s |
| pty-flood: frames, CPU | 5.7 fps, 253% | | 5.9 fps, 282% |

Chromium moved too between F2 and M5 on the same scenarios (pty-flood reply p50 64 to 154 ms, burst 2.16 to 1.59 MB/s, idle CPU 6.6 to 11.7%), which points at the host or the server rather than either client for those rows. Only the startup regression was checked on one day with both bundles (above).

## Limiters

Per-thread CPU in the measure phase, median over the runs (`runs-report.ts`), in percent of one core.

| Scenario | GPUIX | Chromium |
|---|---|---|
| idle | `bun` 8.0, `gpuix-ui` 2.3, `mi-scavenger` 1.8 | page renderer `ThreadPoolForeg` 2.1, page renderer main 1.5 |
| pty-flood | `llvmpipe-N` 186, `bun` 41, `gpuix-ui` 29, `mi-scavenger` 14 | GPU process `llvmpipe-N` 102, GPU main 31, page renderer main 29 |
| stream-storm, 8 chats | `llvmpipe-N` 150, `bun` 51, `gpuix-ui` 40, `mi-scavenger` 10 | GPU process `llvmpipe-N` 81, page renderer main 74, page renderer `ThreadPoolForeg` 23 |
| stream-storm, 4 chats | `llvmpipe-N` 184, `bun` 44, `gpuix-ui` 33 | GPU process `llvmpipe-N` 113, page renderer main 56 |

- **GPUIX is bound by software rasterization in every loaded scenario.** Its lavapipe threads use 1.5 to 1.9 cores; its UI thread uses 29% to 40% of one and its JS thread 41% to 51%. In F2 the 8-chat limit was the UI thread at 90%; F3's hidden-pane parking and the later transcript and chat-start fixes took it off the critical path. A GPU would move the lavapipe work off the CPU. That is an inference from the thread profile, not a measurement.
- **Chromium is bound by the GPU process's lavapipe threads plus the page renderer's main thread**, as in F2.
- **The startup regression's limiter is not identified.** The head does about 27% more CPU work before the launcher is ready. An unreported `bun --cpu-prof-md` run of each bundle put most samples inside the GPUIX runtime's native pump and React commits, with too few JS samples to name a hot spot. The next step is a startup trace with timestamps per boot stage in both bundles.

## Method

| Item | Value |
|---|---|
| Machine | 8 vCPU AMD EPYC (KVM guest), 23 GiB RAM, Linux 6.8.0-147, no GPU. No other GPUIX unit ran. Another agent's QA job (an Xvfb, two `termul-server` test servers and its agent) ran the whole time: foreign CPU in the idle runs was 107% to 141% of a core, and the 1-minute load average before the runs was 1.9 to 12.5. |
| GPUIX client | Production bundle `apps/gpuix/dist/main.js` (`bun run build`) of `gpuix/m5` at c037d87e's app code, GPUIX 0.11.0 on Bun 1.4.0, on the self-built patched addon (`NAPI_RS_NATIVE_LIBRARY_PATH=native/gpuix-native/build/gpuix-native.linux-x64-gnu.node`, series e24c33d4). Every record names the addon the process mapped (`meta.clientVersion`) and the Vulkan driver (`libvulkan_lvp.so`). |
| Web client | The worktree's `dist-web/` in Playwright Chromium, headed, `--gl lavapipe`. |
| Shipped app | `termul-manager` built from this head with `tauri.conf.dev.json` (WebKitGTK 2.52.6), startup and idle only. |
| Server | `termul-server` release build of this head (`--features standalone-server`), fresh state per run under `/tmp/gpuix-m5/pstate/`, port 8196 behind the byte relay on 8197, Xvfb `:181` at 1440x900. |

Commands, from `apps/gpuix`, with `NAPI_RS_NATIVE_LIBRARY_PATH` exported:

```bash
bun run perf --client gpuix,chromium --scenarios idle,stream-storm,pty-flood --runs 5 --page-metrics off \
  --state-root /tmp/gpuix-m5/pstate/main --out tools/perf/results-m5/main --quiet-wait 300 \
  --server-bin /root/termul-wt/gpuix/src-tauri/target/release/termul-server
bun run perf --client gpuix,chromium --scenarios stream-storm --agents 2 --runs 5 --page-metrics off \
  --state-root /tmp/gpuix-m5/pstate/storm4 --out tools/perf/results-m5/storm4 --quiet-wait 300 \
  --server-bin /root/termul-wt/gpuix/src-tauri/target/release/termul-server
bun tools/perf/webkit-startup.ts --runs 5 --state-root /tmp/gpuix-m5/pstate/webkit --out tools/perf/results-m5/webkitgtk --quiet-wait 300
bun tools/perf/ab.ts --variants f2=gpuix:dist-sf2,head=gpuix:dist --runs 5 --out tools/perf/results-m5/startup-ab \
  -- --scenarios idle --page-metrics off --quiet-wait 300 --state-root /tmp/gpuix-m5/pstate/startab \
  --server-bin /root/termul-wt/gpuix/src-tauri/target/release/termul-server
bun tools/perf/runs-report.ts tools/perf/results-m5/main measure sustained-stream flood burst
bun run perf:report gpuix=tools/perf/results-m5/main/gpuix chromium=tools/perf/results-m5/main/chromium
```

`dist-sf2/` is `bun build.ts` of a `git archive eceaec17` checkout, copied into `apps/gpuix` so it resolves the same `node_modules`. The runner interleaves the clients and reverses the order on even runs. Before each run it waited for a 5 s whole-machine CPU sample under 150% of one core; every run started after the first 5 s or 10 s sample, at 88% to 143%. Nothing else of M5's ran during a perf run: the parity matrix finished before the first set, and the package was built after the last.

## What the numbers mean, and their limits

- **Everything is rendered in software.** GPUIX draws with Vulkan on Mesa lavapipe, Chromium with ANGLE on the same lavapipe, WebKitGTK with its software GL. Frame rates and most CPU under load measure software rasterization on both sides.
- **The host was shared.** Another agent's QA job used about one core throughout. The runs are interleaved, so it fell on both clients alike, but latency and frame numbers carry its noise.
- **Startup readiness is an element, not a pixel**, for GPUIX and Chromium. WebKitGTK's is a pixel test.
- **The GPUIX driver costs the app UI-thread time.** During startup the automation tree reads blocked the UI thread for 234 ms per second (`startup.ui.getAutomationTreeBlockedMsPerS`, head bundle). The F2 bundle predates those counters, so the A/B cannot say whether the driver's cost changed. The measure phases send no driver calls.
- **Five runs a side detect only large differences.**
