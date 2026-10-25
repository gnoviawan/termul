# Hidden panes and the GPUIX UI thread (F3)

This page explains why the GPUIX client slowed down as chats were added, what changed, and what still limits it. [`gpuix-vs-baseline.md`](gpuix-vs-baseline.md) has the F2 comparison that found the problem, and [`README.md`](README.md) describes the runner and the `tree.*` and `ui.*` keys used here.

## What was wrong

Termul keeps inactive chats, tabs and project trees mounted so that their state survives. A hidden pane is `absolute inset-0 invisible`. A browser lays such a subtree out once and then leaves it alone. GPUIX 0.11 builds the GPUI element tree from the window root on every frame (`GpuixView::render` calls `build_element` on the root), so Taffy lays out every reachable element on every frame. `visibility: hidden` skips only the paint. GPUIX ignores `display: none`, and compat drops the children of a `display: none` element, which would lose their state.

The automation-tree census proves it in the real app. In the base bundle's second 8-chat run, after the chats opened, 31,068 elements were reachable from the root and 1,267 of them were painted. The other 29,781 were the hidden chats' transcripts (the five largest held 17,584, 8,750, 1,196, 1,070 and 1,056 elements), built and laid out on every frame and never drawn. That run then stopped answering the driver within 12 s and was recorded as failed.

## What changed

`src/compat/park.ts` wraps the renderer's `applyBatch`. When an element's style becomes a hidden full-bleed overlay (`visibility: hidden`, `position: absolute`, all four insets 0), the element moves under a native node that is not reachable from the root, and an empty placeholder takes its slot among its siblings. Ops that place a sibling before the parked element, or move it, are rewritten to the placeholder. When the style turns visible, the element returns to the placeholder's slot. React state, terminals, scroll offsets and list state stay as they were. A parked pane is not under its React ancestors in the native tree, so when an ancestor is destroyed, park frees the pane whose placeholder went with it. `tools/compat/park.test.tsx` drives real React through GPUIX's reconciler into a model of the retained tree and checks state, sibling order, moves, and frees of the pane and of its ancestors.

Under the 8-chat load, the base bundle also crashed when a synchronous read (a key handler's focus read, TanStack Virtual's `scrollLeft`, the transcript's `getListScrollTop`) hit GPUIX's 2 s UI-thread timeout. F3 first guarded compat's reads in a `busy-ui.ts` adapter. G2's `src/native-guard.ts`, merged from `exp/gpuix-client` at `8523c582`, guards the same reads at the renderer, so F3 deleted its adapter.

## Results

### Microbenchmark: 150-row panes behind a 20 Hz ticker

`bun tools/perf/hidden/run.ts --runs 3 --panes 1,4,8`, median `gpuix-ui` CPU in percent of one core. `none` has no panes, `hidden` mounts them `absolute inset-0` with `visibility: hidden`, `parked` moves them by hand, and `compat` installs `parkHiddenPanes`.

| Panes | hidden | parked | compat |
|---|---|---|---|
| 0 | 10.9 | | |
| 1 | 45.1 | 8.9 | 11.2 |
| 4 | 70.1 | 19.4 | 11.2 |
| 8 | 86.0 | 13.6 | 18.5 |

### stream-storm, 8 chats, with G2's transcript changes

`bun tools/perf/build-variants.ts`, then `bun tools/perf/ab.ts --variants base=gpuix:dist-sbase,park=gpuix:dist,chromium=chromium --runs 3 --out tools/perf/results-f3/storm8-merged -- --scenarios stream-storm --page-metrics off --quiet-wait 400 --port 8192 --display :184`, on this branch after merging `exp/gpuix-client` at `8523c582` (G2's native-guard, and a transcript that reads its follow state once per settled scroll instead of polling). `base` is the same build with `parkHiddenPanes` replaced by a no-op at bundle time. The machine was not quiet: other units ran benchmarks throughout, and the quiet gate let runs start at a load average of 2.3 to 10.3. Records are in [`results-f3/storm8-merged/`](results-f3/storm8-merged/). With 3 runs per variant, the smallest two-sided rank-sum p is 0.1, so read these as consistent differences, not tested ones.

Each cell lists the runs in order. PSS is the client's process tree (Chromium: browser, renderer and GPU process).

| Metric | base | park | Chromium |
|---|---|---|---|
| Runs that finished | 2 of 3 | 3 of 3 | 3 of 3 |
| Chats open at the end (of 8) | 7, 7, - | 8, 6, 8 | 8, 8, 8 |
| Elements reachable from the root, measure | 42,780, 65,682, - | 4,804, 22,045, 4,380 | |
| Of those, hidden and never painted | 39,365, 23,448, - | 36, 20, 26 | |
| Chat start while others stream, p50 (s) | 120.9, 121.3, - | 9.4, 20.0, 11.4 | 10.1, 14.9, 11.1 |
| Typing part of that start, p50 (s) | 84.8, 88.3, - | 7.2, 15.6, 8.1 | 6.0, 9.4, 7.0 |
| Frames on screen while switching chats | 0.3, 0.2, - | 2.1, 0.8, 2.9 | 6.3, 11.4, 11.1 |
| Frames on screen, measure phase | 0.2, 0.1, - | 2.3, 0.4, 1.9 | 5.4, 3.4, 4.3 |
| Client PSS, measure, median (MB) | 1,908, 2,760, - | 1,046, 3,902, 997 | 1,480, 1,329, 1,332 |
| Client PSS, measure, peak (MB) | 1,960, 2,786, - | 1,081, 4,010, 1,047 | 1,609, 1,383, 1,391 |
| Client RSS, measure, peak (MB) | 2,015, 2,887, - | 1,135, 4,078, 1,102 | 2,274, 2,061, 2,061 |
| `gpuix-ui` CPU, measure (% of a core) | 95, 79, - | 81, 86, 69 | |
| Mutation JSON sent, measure (KB/s) | 5,126, 2,217, - | 5,184, 1,656, 3,608 | |

Base's third run never finished. After 30 minutes its client still ran at 175% CPU with a PSS of 3,788 MB (read from `/proc/<pid>/smaps_rollup`), and the driver waited on it with no deadline, so the run was stopped by hand and left no record. Its first two runs each lost one chat start ("launcher composer never accepted"), and park's second run lost two.

Parking keeps the hidden part of the tree at 20 to 36 elements, against 23,000 to 39,000 without it. Starting a chat while 7 others stream drops from about 2 minutes to 9 to 20 s, against Chromium's 10 to 15 s. Memory follows the reachable tree. In park's first and third runs, PSS in the measure phase was about 1,000 MB, below Chromium's 1,330 to 1,480 MB. Base used 1,908 and 2,760 MB, and 3,788 MB in the run that never finished. Park's second run used 3,902 MB because of one row, described below. GPUIX still draws fewer frames than Chromium, 0.4 to 2.3 fps in the measure phase against 3.4 to 5.4.

### stream-storm, 8 chats, before G2's transcript changes

These runs predate the merge of `8523c582`. They used `--runs 4`, stopped after 3 rounds for time, and `--quiet-wait 300`. All three GPUIX bundles carried G2's `getListScrollTop` try/catch, applied locally. `nopoll` removed the transcript's 120 ms `getListScrollTop` poll as an experiment, which G2 has since replaced. Other units ran builds and benchmarks during every run (load average 5 to 16). Records are in [`results-f3/storm8/`](results-f3/storm8/).

Each cell lists the runs. A dash means the run did not reach that point.

| Metric | base | park | nopoll | Chromium |
|---|---|---|---|---|
| Runs that finished | 2 of 3 | 3 of 3 | 3 of 3 | 3 of 3 |
| Chats open at the end | 4, -, 5 | 6, 8, 7 | 7, 8, 5 | 8, 8, 8 |
| Elements reachable from the root, measure | 192, -, 206 | 2655, 2844, 2721 | 2813, 2826, 2592 | |
| Of those, hidden and never painted | 1, -, 1 | 20, 26, 23 | 23, 26, 17 | |
| Chat start while others stream, p50 (s) | 29.4, 26.9, 129.0 | 18.2, 13.3, 11.9 | 13.1, 10.3, 72.5 | 24.3, 16.0, 18.7 |
| Typing part of that start, p50 (s) | 18.1, -, 79.0 | 12.2, 7.9, 7.9 | 9.0, 6.6, 51.5 | 17.0, 9.4, 12.8 |
| Frames on screen while switching chats | 8.2, 0.2, 5.6 | 3.2, 4.9, 4.0 | 4.4, 4.2, 3.4 | 8.1, 8.1, 7.2 |
| Frames on screen, measure phase | 6.9, -, 5.6 | 2.3, 2.5, 2.6 | 2.9, 2.0, 2.2 | 6.2, 1.8, 5.7 |
| Client PSS, measure (MB) | 1010, -, 1141 | 1116, 422, 495 | 504, 482, 987 | 1432, 1308, 1364 |
| `gpuix-ui` CPU, measure (% of a core) | 22, -, 23 | 63, 55, 59 | 62, 56, 65 | |
| JS blocked on `getListScrollTop`, measure (ms per s) | -, -, - | 944, 848, 854 | 0, 0, 0 | |

Read the base column with care. Its two finished runs had lost the workspace pane by the measure phase: the tree held 192 and 206 elements, the shell with no transcript, so its measure frame rate is of an almost empty window. Its second run is the one with 29,781 hidden elements, and it stopped answering.

With parking, every run finished, 6 to 8 chats opened, and the hidden part of the tree fell from tens of thousands of elements to about 20. Starting a chat while others stream took 12 to 18 s against Chromium's 16 to 24 s, and the typing part of it 8 to 12 s against 9 to 17 s. GPUIX still draws fewer frames than Chromium: 2.3 to 2.6 fps in the measure phase against a Chromium median of 5.7. The F2 measurement of the same load on `exp/gpuix-client` was 0.8 fps, about 1.5 s per typed key, and 1 of 5 runs finished.

### stream-storm, 4 chats, with G2's transcript changes

The same command with `--agents 2` and `--out tools/perf/results-f3/storm4`, at the same commit, on the same busy machine (load average 4.9 to 9.0 at each start). Records are in [`results-f3/storm4/`](results-f3/storm4/).

| Metric | base | park | Chromium |
|---|---|---|---|
| Runs that finished | 3 of 3 | 3 of 3 | 3 of 3 |
| Chats open at the end (of 4) | 3, 3, 3 | 3, 3, 4 | 4, 4, 4 |
| Elements reachable from the root, measure | 34,996, 27,583, 31,265 | 16,588, 11,231, 4,752 | |
| Of those, hidden and never painted | 31,582, 11,614, 16,267 | 64, 43, 35 | |
| Largest row, the live turn's activity | | 16,305, 10,948, 4,419 | |
| Chat start while others stream, p50 (s) | 84.3, 15.0, 20.8 | 81.5, 7.6, 11.0 | 10.1, 15.0, 13.8 |
| Typing part of that start, p50 (s) | 62.1, 10.6, 14.9 | 57.3, 5.7, 7.6 | 6.1, 10.6, 9.6 |
| Frames on screen while switching chats | 0.4, 0.5, 0.4 | 2.3, 0.7, 3.0 | 7.5, 5.1, 5.6 |
| Frames on screen, measure phase | 0.3, 0.3, 0.3 | 0.5, 0.8, 1.6 | 2.5, 4.6, 3.8 |
| Client PSS, measure, median (MB) | 1,556, 1,334, 1,567 | 1,214, 987, 488 | 1,014, 1,119, 1,102 |
| Client PSS, measure, peak (MB) | 1,598, 1,433, 1,618 | 1,262, 1,050, 578 | 1,026, 1,140, 1,109 |
| `gpuix-ui` CPU, measure (% of a core) | 91, 95, 90 | 87, 87, 69 | |

Every GPUIX run but one lost a chat start ("launcher composer never accepted"), with or without parking. The p50 start time of a run that lost one is taken over its three remaining chats, and the 80 s values include the start right after the failed one. With four chats the hidden tree is smaller than with eight, but parking still cuts it from 11,600 to 31,600 elements to under 70. What is left is the live turn's activity row, which held 4,419 to 16,305 elements and kept the frame rate at 0.5 to 1.6 fps against Chromium's 2.5 to 4.6.

### Where the mutation stream goes: spinners

`TERMUL_GPUIX_STATS_OPS=1 bun tools/perf/run.ts --client gpuix --runs 1 --scenarios stream-storm --page-metrics off --gpuix-dist dist ...` makes `src/renderer-stats.ts` count every op by kind, and `setCustomProp` by key. It parses every batch, so these two runs are for the breakdown only, not for timing. Records are [`results-f3/ops/by-kind.json`](results-f3/ops/by-kind.json) and [`results-f3/ops/by-key.json`](results-f3/ops/by-key.json).

In the measure phase of the second run, the client sent 4,703 KB/s. Of that, `setCustomProp` with the key `source` was 4,632 KB/s (98.5%), at 427 sets per second, about 10.8 KB each. Text was not the cost: `setText` was under 10 KB/s in both runs. The `source` is the spinner's. `src/ui/spinner.tsx` draws its comet as an SVG of 72 wedges, about 11 KB at 16 px, and GPUIX has no transform to rotate it (`gpuix-capabilities.md`, Transforms), so each 10° step sends a new SVG, 36 steps per 700 ms lap, about 51 a second. 427 sets per second is about 8 spinners at 51 steps each.

Those spinners are on screen. A streaming chat shows a spinner in its sidebar row and in its workspace tab, and the project row shows one: a frame grabbed mid-run ([`/tmp/gpuix-f3/evidence/storm-spinners-a.png`](/tmp/gpuix-f3/evidence/storm-spinners-a.png)) shows 10, with 5 chats open. Only a chat's "Working…" row sits in a parked pane. A first fix that skipped steps in parked panes (`71e26c50`, still in the code) changed nothing measurable: in [`results-f3/storm8-spin/`](results-f3/storm8-spin/), the client sent 2,561 to 4,601 KB/s with it and 2,600 to 4,403 KB/s without it (`prespin`), and `gpuix-ui` used a median 71% and 75% of a core.

The fix that holds is in `src/ui/spinner.tsx` and `src/env/comet-frames.ts`:

- Each frame is written once to `<client state dir>/comet-frames/<size>-<angle>-<content hash>.svg`, and a step sets the svg's `src` to that path. GPUIX reads a desktop `src` from disk (`SvgElement::load_src`), so a step costs about 100 bytes of JSON instead of 11 KB. Without the env (unit tests, the ui gallery), a step still sends the markup.
- One shared clock steps every spinner, so all of them change in one React commit, one `applyBatch` and one window wake per step, instead of one per spinner.

`tools/ui/spinner.test.tsx` checks that three spinners step in the same batch and that each `src` file holds the frame. The ui gallery's GPUIX frame is pixel-identical before and after (0 differing pixels at threshold 0, `/tmp/gpuix-f3/gallery-before/termul-controls-gpuix.png` against `/tmp/gpuix-f3/gallery-after/termul-controls-gpuix.png`).

With the fix, the same op breakdown ([`results-f3/ops/frames-by-key.json`](results-f3/ops/frames-by-key.json)) shows 189 KB/s of mutation JSON in the measure phase, against 4,703 KB/s before: 463 `src` sets per second at 48 KB/s, and 48 `source` sets per second (other icons) at 33 KB/s. JS time blocked in `applyBatch` went from 167 to 116 ms per second.

### stream-storm, 8 chats, frame-file spinners

`bun tools/perf/build-variants.ts park presrc`, then `bun tools/perf/ab.ts --variants frames=gpuix:dist,presrc=gpuix:dist-spresrc,chromium=chromium --runs 5 --out tools/perf/results-f3/storm8-frames -- --scenarios stream-storm --page-metrics off --quiet-wait 300 --port 8192 --display :184`, after merging `exp/gpuix-client` at `9747b6c2` (G3, G4). `frames` is the branch; `presrc` is the same build with `src/ui/spinner.tsx` taken whole from `dfee0529`. Chromium serves this worktree's `dist-web`, rebuilt after the merge. Other units ran throughout (load average 3.4 to 15.8 at the starts). Records are in [`results-f3/storm8-frames/`](results-f3/storm8-frames/). Cells list runs 1 to 5.

| Metric | frames | presrc | Chromium |
|---|---|---|---|
| Chats open at the end (of 8) | 6, 7, 8, 5, 7 | 6, 6, 6, 5, 6 | 8, 8, 8, 8, 8 |
| Mutation JSON sent, measure (KB/s) | 44, 49, 55, 32, 50 | 2,510, 3,019, 2,828, 2,158, 2,622 | |
| Elements reachable from the root, measure | -, 20,654, 4,614, 33,774, 3,414 | 33,004, 18,472, 18,752, 33,006, 30,442 | |
| `gpuix-ui` CPU, measure (% of a core) | 57, 91, 72, 89, 63 | 94, 95, 92, 92, 96 | |
| Frames on screen, measure phase | 0.1, 0.4, 1.6, 0.3, 1.8 | 0.2, 0.5, 0.5, 0.3, 0.4 | 6.8, 3.9, 2.9, 5.2, 2.3 |
| Chat start while others stream, p50 (s) | 19.6, 11.1, 10.4, 41.0, 7.6 | 14.1, 11.3, 18.9, 78.5, 19.5 | 13.4, 11.3, 4.2, 9.4, 4.5 |
| Typing part of that start, p50 (s) | 14.4, 6.4, 8.2, 32.8, 5.4 | 10.9, 8.5, 10.9, 61.6, 14.0 | 7.0, 6.3, 1.5, 6.2, 1.5 |
| Client PSS, measure, median (MB) | 3,835, 2,174, 1,096, 3,264, 833 | 1,948, 1,404, 1,432, 2,341, 2,217 | 1,438, 1,245, 1,204, 1,296, 1,238 |
| Client PSS, measure, peak (MB) | 3,892, 2,246, 1,127, 3,430, 866 | 2,087, 1,412, 1,492, 2,378, 2,281 | 1,546, 1,296, 1,217, 1,309, 1,247 |

Run 1 of `frames` has no tree count because the census query timed out on the busy UI thread. Every GPUIX run lost one to three chat starts ("launcher composer never accepted", or "a new chat card and a closed launcher"); Chromium lost none.

The fix did what it targets. Mutation JSON fell from 2.2 to 3.0 MB/s to 32 to 55 KB/s, every `frames` run below every `presrc` run (rank-sum p = 0.008). `gpuix-ui` CPU was lower in every `frames` run (p = 0.008), but read that with the tree size beside it: at a similar tree, run 2 (20,654 against 18,472 elements) used 91% against 95%, and run 4 (33,774 against 33,006) 89% against 92%. The larger drops, to 57 to 72%, are the runs whose visible transcript was small. So the spinners were not what kept the UI thread busy. Frame rate, chat start and typing are not distinguishable between the two (p ≥ 0.42).

The coordinator asked for GPUIX PSS under this load against Chromium's 1,469 MB baseline. GPUIX's measure-phase PSS follows the reachable tree, not the spinner: 833 and 1,096 MB in the two runs with 3,400 to 4,600 reachable elements, below Chromium's 1,204 to 1,438 MB in these runs and below the 1,469 MB baseline, and 2,174 to 3,835 MB in the runs with 20,000 to 34,000. Across the `frames` runs that is about 80 KB of PSS per reachable element (inferred from the two ends: (3,264 − 833) MB over (33,774 − 3,414) elements). The median `frames` run used 2,174 MB, 1.5 times the baseline.

In the warmup phase, with one chat streaming, `frames` used 306 to 340 MB against `presrc`'s 228 to 284 MB (p = 0.008). The spinner microbenchmark below does not show the frame store adding memory, so this difference is not explained.

### Spinner microbenchmark

`bun tools/perf/spinner/run.ts --runs 3 --counts 1,10 --seconds 15` renders N spinners in an 800×600 window with nothing else changing, interleaving `source` (no frame store) and `frames`. Medians, record in [`results-f3/spinner/spinners.json`](results-f3/spinner/spinners.json), load average 9 to 13:

| Spinners | Mode | `gpuix-ui` (% of a core) | Whole process (% of a core) | PSS (MB) |
|---|---|---|---|---|
| 0 | either | 1 | 2 to 5 | 162 |
| 1 | source | 14 | 72 | 181 |
| 1 | frames | 13 | 64 | 178 |
| 10 | source | 13 | 86 | 196 |
| 10 | frames | 12 | 70 | 185 |

One visible spinner on an otherwise idle window costs about 13% of a core on `gpuix-ui` and 40 to 46% in lavapipe's `llvmpipe` threads, because each step redraws the whole window in software. Ten cost about the same as one, since they now step together. An earlier run of the same benchmark, before it split CPU by thread, tried 20° steps (26 per second) with the frame store: 10 spinners used 100% of a core for the whole process against 119 to 139% at 10°. That saving is mostly lavapipe's software raster, which a real GPU does not pay, so the step stays at 10° and keeps the web's smoothness.

## What still limits it

- **The visible transcript's live turn.** After parking, one transcript row holds nearly all of the reachable tree: the live turn's activity row (`chat-row-activity:<id>`) with one `Thought · 1 line` child per streamed thought. In the post-merge 8-chat runs it held 4,346, 21,668 and 3,922 of the 4,804, 22,045 and 4,380 reachable elements. Before the merge it held 2,216 to 2,387. A `virtual-list` culls whole rows only, so this row is built and laid out on every frame and grows for as long as the turn streams. It decides both the frame rate and the memory: the run where it reached 21,668 elements drew 0.4 fps and used 3.9 GB. After the G3/G4 merge and the spinner fix it is still the hot subtree: in `storm8-frames` run 2 it held 20,246 of 20,654 reachable elements. This is G2's code. The fix belongs in the activity row: virtualize its children (a nested `virtual-list`), or build only the visible part of a long thought group.
- **Memory per element.** PSS grows by about 80 KB per reachable element (8-chat `frames` runs above), so the live turn's activity row decides memory as well as frame rate. Chromium holds the same transcript in 1.2 to 1.4 GB.
- **Whole-scene rendering.** GPUIX rebuilds and lays out the whole reachable tree on every frame and has no cached subtrees. F2 found that every present covers the whole window. With about 4,500 reachable elements, `gpuix-ui` used 69% to 86% of a core.

## Upstream asks for GPUIX

1. Skip `display: none` subtrees in `build_element` (today `apply_styles` ignores the value), so a hidden subtree costs nothing per frame without moving native nodes.
2. Cached subtrees: reuse the built and laid-out elements of a subtree whose `subtree_revision` did not change. Kybern carries this as its "cached islands" patch (`reports/kybern.md` item 2).
3. Push scroll and list state to JS as events instead of synchronous queries with a 2 s timeout, or make the timeout a non-throwing "no answer".
4. A `transform: rotate()` style (GPUIX #102), or an animated svg drawn by GPUI itself. A spinner step now sends about 100 bytes, but it still wakes the window, and the window rebuilds, lays out and redraws everything, about 13% of a core on `gpuix-ui` for one spinner on an idle window.
