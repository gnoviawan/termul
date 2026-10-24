# Hidden panes and the GPUIX UI thread (F3)

This page explains why the GPUIX client slowed down as chats were added, what changed, and what still limits it. [`gpuix-vs-baseline.md`](gpuix-vs-baseline.md) has the F2 comparison that found the problem, and [`README.md`](README.md) describes the runner and the `tree.*` and `ui.*` keys used here.

## What was wrong

Termul keeps inactive chats, tabs and project trees mounted so that their state survives. A hidden pane is `absolute inset-0 invisible`. A browser lays such a subtree out once and then leaves it alone. GPUIX 0.11 builds the GPUI element tree from the window root on every frame (`GpuixView::render` calls `build_element` on the root), so Taffy lays out every reachable element on every frame. `visibility: hidden` skips only the paint. GPUIX ignores `display: none`, and compat drops the children of a `display: none` element, which would lose their state.

The automation-tree census proves it in the real app. In the base bundle's second 8-chat run, after the chats opened, 31,068 elements were reachable from the root and 1,267 of them were painted. The other 29,781 were the hidden chats' transcripts (the five largest held 17,584, 8,750, 1,196, 1,070 and 1,056 elements), built and laid out on every frame and never drawn. That run then stopped answering the driver within 12 s and was recorded as failed.

## What changed

`src/compat/park.ts` wraps the renderer's `applyBatch`. When an element's style becomes a hidden full-bleed overlay (`visibility: hidden`, `position: absolute`, all four insets 0), the element moves under a native node that is not reachable from the root, and an empty placeholder takes its slot among its siblings. Ops that place a sibling before the parked element, or move it, are rewritten to the placeholder. When the style turns visible, the element returns to the placeholder's slot. React state, terminals, scroll offsets and list state stay as they were. A parked pane is not under its React ancestors in the native tree, so when an ancestor is destroyed, park frees the pane whose placeholder went with it. `tools/compat/park.test.tsx` drives real React through GPUIX's reconciler into a model of the retained tree and checks state, sibling order, moves, and frees of the pane and of its ancestors.

`src/compat/busy-ui.ts` makes compat's synchronous DOM reads (focus, scroll offset, bounds, tree) answer "none" when GPUIX's 2 s UI-thread timeout fires. Without it, the base bundle crashed under the 8-chat load from a key handler's focus read and from TanStack Virtual's `scrollLeft`, the same failure class as the transcript's `getListScrollTop` crash.

## Results

### Microbenchmark: 150-row panes behind a 20 Hz ticker

`bun tools/perf/hidden/run.ts --runs 3 --panes 1,4,8`, median `gpuix-ui` CPU in percent of one core. `none` has no panes, `hidden` mounts them `absolute inset-0` with `visibility: hidden`, `parked` moves them by hand, and `compat` installs `parkHiddenPanes`.

| Panes | hidden | parked | compat |
|---|---|---|---|
| 0 | 10.9 | | |
| 1 | 45.1 | 8.9 | 11.2 |
| 4 | 70.1 | 19.4 | 11.2 |
| 8 | 86.0 | 13.6 | 18.5 |

### stream-storm, 8 chats

`bun tools/perf/build-variants.ts`, then `bun tools/perf/ab.ts --variants base=gpuix:dist-sbase,park=gpuix:dist,nopoll=gpuix:dist-snopoll,chromium=chromium --runs 4 -- --scenarios stream-storm --page-metrics off --quiet-wait 300`, stopped after 3 rounds for time. `base` is this branch without parking, `park` is this branch, and `nopoll` is this branch with the transcript's 120 ms `getListScrollTop` poll removed (an experiment for G2, not a proposed build). All GPUIX bundles carry G2's `getListScrollTop` try/catch, which `build-variants.ts` applies at bundle time without touching G2's file. Other units ran builds and benchmarks during every run (load average 5 to 16). Records are in [`results-f3/storm8/`](results-f3/storm8/).

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

### stream-storm, 4 chats

STORM4

## What still limits it

- **The visible transcript's live turn.** With parking, about 2,700 elements stay reachable. In every park and nopoll run of the 8-chat set, one `virtual-list` row, `chat-row-activity:turn:<id>`, held 2,216 to 2,387 of them: the live turn's activity, with 149 to 161 `Thought · 1 line` children. A `virtual-list` culls whole rows only, so that row is built every frame and grows while the turn streams. This is G2's code.
- **Synchronous scroll polling.** `useListFollow` calls `getListScrollTop` every 120 ms from each mounted transcript. Each call waits for the UI thread to finish its frame, so the JS thread spent 850 to 950 ms of every second blocked there. Removing the poll (`nopoll`) freed that time but did not raise the frame rate, so it is not the frame limiter. It still blocks input handling, and a pushed follow state would remove it. This is G2's code.
- **Mutation volume.** The client sent 0.8 to 1.0 MB of mutation JSON per second for about 19 KB/s of streamed text (8 chats, 20 updates of 120 characters per second), 40 to 55 times the text. A guess: each chunk resends the whole growing markdown source of its block.
- **Whole-scene rendering.** GPUIX rebuilds and lays out the whole reachable tree on every frame and has no cached subtrees. F2 found that every present covers the whole window. With 2,700 elements, `gpuix-ui` used 55% to 65% of a core and lavapipe about 85%.

## Upstream asks for GPUIX

1. Skip `display: none` subtrees in `build_element` (today `apply_styles` ignores the value), so a hidden subtree costs nothing per frame without moving native nodes.
2. Cached subtrees: reuse the built and laid-out elements of a subtree whose `subtree_revision` did not change. Kybern carries this as its "cached islands" patch (`reports/kybern.md` item 2).
3. Push scroll and list state to JS as events instead of synchronous queries with a 2 s timeout, or make the timeout a non-throwing "no answer".
