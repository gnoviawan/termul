# Canvas eval

A repeatable check that the Termul Canvas design harness (issue #1430) makes designs from thin prompts better, not just different. It runs each prompt in `prompts.json` in a fresh agent session on an empty canvas, once with the harness and once without, renders each result to PNG, checks layout integrity automatically, and has a second model score the images blind against `rubric.md`.

## What runs where

- **The agent** is Claude Code in print mode (`claude -p`), with its built-in tools turned off and only the `termul` MCP server available. Set `CANVAS_EVAL_AGENT` to use another binary with the same flags.
- **The `termul` server** is `mcp-router.ts`. It takes the instructions and tool definitions from a real Termul binary (`--internal-mcp-plan-server`), runs `read_canvas_guide` and `get_canvas_style` in that binary, and runs canvas tools in `figcraft-cli mcp`, the headless build of the same engine the app embeds.
- **Baseline mode** hides the two harness tools and drops the instruction sentences that name them, which is what an agent saw before the harness. `session.json` in each run folder records exactly what the agent was shown.
- **Results** go to `out/<timestamp>/<prompt id>/<mode>/`: `design.figcraft`, `design.png`, `document.json` (the layer tree), `calls.jsonl` (every tool call), `transcript.jsonl` (the agent's stream) and `result.json`.

## Run it

You need a Termul binary built from this branch and `figcraft-cli` built from the fork tag in `canvas/figcraft.pin`.

```sh
# in src-tauri
cargo build --bin termul-manager
# in a checkout of gnoviawan/figcraft at the pinned tag
cargo build --release -p figcraft-cli

node scripts/canvas-eval/run.ts run --termul <path to termul-manager> --figcraft <path to figcraft-cli> --out scripts/canvas-eval/out/first
node scripts/canvas-eval/run.ts judge --out scripts/canvas-eval/out/first
node scripts/canvas-eval/run.ts report --out scripts/canvas-eval/out/first
```

`--only landing-toko-roti,dashboard-gym` runs a subset, `--modes harness` one mode, and `--model` picks the agent and judge model. Each run costs one full agent session; the whole set is 24 sessions plus 24 judge calls.

## Automatic and manual parts

Automatic:

- One fresh session per prompt and mode, on an empty headless canvas.
- The PNG of the whole page, from `figcraft-cli render`.
- Layout integrity (`checks.ts`): collapsed frames and text, clipped text, invisible text, fonts the in-app canvas does not render, placeholder copy, an empty canvas.
- Effort: tool calls, failed calls, agent turns, cost and time.
- Blind judging of the other rubric items by a second model, and the report with medians per mode.

Manual:

- **The human spot check.** Look at every image in `out/<run>/judge/` next to its scores and record corrections in `judge/overrides.json` before you report a number.
- **Non-Claude agents.** Codex, Gemini CLI and OpenCode take MCP servers through their own config files, so `run.ts` does not drive them. Point their MCP config at the same `mcp-router.ts` command line (see any run's `mcp.json`), give each prompt in a fresh session, and the router writes the same files. `run.ts report` reads them if you add a `result.json`, or rerun `checks.ts` on `document.json`.
- **The in-app surface.** The headless engine renders with the native text stack and has more font families than the app's wasm build, which embeds only Inter. `checks.ts` flags other families as failures for that reason, but a design can still look different in the app. Open a run's `design.figcraft` in Termul Canvas to compare.
