---
name: perf-toolkit
description: Run Termul performance benchmarks, read the reports, and do before/after A/B compares with the tools/perf toolkit. Use when the user asks to measure app performance, run a perf scenario (stream-storm, project-switch, pty-flood, soak), compare runs, or investigate renderer jank/memory.
---

# Termul Perf Toolkit

Measures the desktop app's renderer performance under controlled, deterministic load: fake ACP agents stream seeded `sessionUpdate` traffic through the app's real custom-agent path while passive collectors capture React commits, page-level jank (LoAF/longtask/INP/rAF), and OS-level renderer memory/CPU. Every run writes a result directory with `result.json` + a self-contained `report.html`.

## Quick start

```bash
bun run perf -- --help          # usage; launches nothing
bun run perf -- self-test       # determinism + report smoke, no app
bun run perf -- stream-storm --agents 4 --seed 42
```

The `perf` script runs the toolkit under **Node** (`node tools/perf/cli.ts`):
Playwright's `connectOverCDP` times out under Bun 1.3.x against the WebView2
CDP endpoint (bundled-`ws` incompatibility), so the runner moved to Node —
`.ts` sources execute directly via Node 24 type stripping; relative imports
carry explicit `.ts` extensions for that reason. Only the fake-agent
subprocess stays on Bun (it uses `Bun.stdin`/`Bun.file`), spawned by the app
exactly as registered.


The app exe must exist — **the worktree dev-identifier build**
(`src-tauri/target/release/termul-manager.exe`, identifier
`com.termul-manager.app.dev`). It must be built with the dev config so it
escapes the user's installed-instance single-instance mutex AND carries
`withGlobalTauri`:
`bun x @tauri-apps/cli build --config src-tauri/tauri.conf.dev.json`
(run `bun run build:frontend:tauri` first). Fallbacks: the worktree
`x86_64-pc-windows-msvc/release` output, then the main checkout's
`target/x86_64-pc-windows-msvc/release/termul-manager.exe`. Override with
`--exe <path>`; a same-identifier exe exits via the single-instance plugin
when a user instance is running.

## Scenarios

| Command | What it drives | Key flags |
|---|---|---|
| `stream-storm` | K fake agents streaming into S chats, mid-stream tab switches | `--agents 4 --sessions-per-agent 2 --rate 20 --sustain 30` |
| `project-switch` | Repeated project switches under live agent+terminal load | `--projects 3 --cycles 10 --ui` (click sidebar vs store action) |
| `pty-flood` | T terminals running the canned flood script (ANSI/wide/block lines + resize churn) | `--terminals 3 --lines-per-sec 200 --with-agent-stream` |
| `soak` | Long stream + periodic switches (memory slope) | `--minutes 30 --yes` (ask-first: >15 min needs consent) |
| `browser` | CAP-7 secondary lane vs termul-server (stream-storm/project-switch) | `--server http://127.0.0.1:3000` |

Shared: `--seed` (determinism), `--exe`, `--keep-state` (debugging),
`--use-real-agent <id>` (drive a REAL catalog agent instead of the fake —
the runner calls `acp_install_agent`, persists the `installedBinaryConfig`
under `acp-registry:<id>`, and seeds `agents/last-selected` so the launcher
picks it; the same composer UI drives it. `--use-real-agent opencode` plus
the agent's built-in `opencode/*-free` models gives a zero-auth, no-cost
real-agent run).

## Reading a report

Open `tools/perf/results/<run-id>/report.html` (works offline, no external assets):

- **Phases** — warmup / sustained / measure sections with headline stats.
- **Top LoAF scripts by blocking duration** — which JS did the blocking work (CAP-4).
- **Top components by commit count** — which components re-rendered (CAP-4).
- **Heap slope** — linear regression over the JS-heap series: distinguishes allocation churn (flat) from retained growth (monotonic climb — the 2026-09-28 incident signature).
- **Gaps** — anything a collector failed to capture is listed explicitly, never silently missing.

## A/B compare (CAP-5)

```bash
bun run perf -- compare --base tools/perf/results/<run-a> --against tools/perf/results/<run-b>
```

Prints per-metric min/median deltas with verdict lines (`improved` / `regressed` / `flat`) against per-metric thresholds, plus explicit `!` gap lines for metrics missing on either side. Same seed + same scenario → identical verdict. For before/after code changes, run the affected scenario on both code states (same seed) and compare.

## The fake agent (CAP-1)

Registered through the app's own custom-agent persistence (`acp/agents` in `termul-data.json`, `configId: 'custom-perfstub'`, `command: bun`, `args: [tools/perf/fake-agent/fake-agent.ts]`) — zero app modification; the app spawns it over the real stdio JSON-RPC path. Knobs ride on the config's `env`:

- `PERF_AGENT_SEED` — same seed → byte-identical sessionUpdate sequence (event-sequence hash recorded per run).
- `PERF_AGENT_RATE` — updates/sec. `PERF_AGENT_DURATION` — seconds (0 = until cancelled).
- `PERF_AGENT_MARKDOWN_FRACTION` / `PERF_AGENT_THOUGHT_FRACTION` — content mix.
- `PERF_AGENT_TOOL_EVERY` / `PERF_AGENT_PLAN_EVERY` / `PERF_AGENT_USAGE_EVERY` — tool_call/plan/usage_update cadence.
- `PERF_AGENT_TRACE=1` — JSONL stderr trace of every emitted update (determinism debugging).
- `PERF_AGENT_REPLAY=<file>` — emit a recorded fixture verbatim.

`bun tools/perf/fake-agent/fake-agent.ts --self-test` (fake-agent subprocess intentionally stays on Bun — it uses Bun.stdin/Bun.file; the runner, not the agent, moved to Node) verifies PRNG determinism standalone.

## React profiling

Dev builds already carry the DevTools hook (commit counts work out of the box). For release-grade timing, build with the gated alias:

```bash
TERMUL_PERF_PROFILING=1 bun run build:frontend:tauri   # react-dom → react-dom/profiling
```

Unset, the alias is inert — zero behavior change; it never ships.

## CAP-8 vitest lane (no desktop app)

```bash
bun vitest run src/renderer/components/chat/__tests__/perf-commit-counts.test.tsx
```

Counts commits of `ChatMessage` / `ChatMessageList` / `AgentChatPanel` under a synthetic stream through the real acp-store, via React `<Profiler>` onRender. Cheap per-change check before any full scenario run.

## Extending

- **New metric**: add to the in-page observer script (`tools/perf/metrics/page-observers.ts`), a field in `PageMetrics` (`tools/perf/types.ts`), a drain entry, a `summarize()` key, and a compare threshold (`tools/perf/report/compare.ts`).
- **New scenario**: implement `ScenarioDef` (name/defaults/drive) in `tools/perf/scenarios/`, register it in `tools/perf/cli.ts`. Use `ctx.beginPhase()` for phase boundaries — the harness owns launch/attach/collect/teardown.
- **New lane**: see `tools/perf/browser/browser-lane.ts` for the shape (same result schema, different attach).

## Gotchas

- The runner owns the spawned PID tree and kills it (`taskkill /T /F` + parent-PID sweep). If a run crashes hard, check for orphan `termul-manager`/`msedgewebview2` processes.
- Each run uses a scratch `WEBVIEW2_USER_DATA_FOLDER` under `tools/perf/results/<run-id>/userdata/` — the single-instance plugin stays isolated and user data is never touched. `--keep-state` preserves it for debugging.
- Numbers are per-machine: only compare runs from the same machine; use the same `--seed`.
- Windows-only desktop lane (WebView2 needs an interactive session). Browser lane covers headless.
