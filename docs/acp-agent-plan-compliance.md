# ACP Agent Plan Compliance

**Date:** 2026-07-17  
**Spec:** [Agent Plan](https://agentclientprotocol.com/protocol/v1/agent-plan)

## Termul client behavior

Termul renders execution plans **only** from the standard ACP wire path:

- Agent sends `session/update` with `sessionUpdate: "plan"`
- Payload includes `entries[]` with `content`, `priority` (`high`|`medium`|`low`), `status` (`pending`|`in_progress`|`completed`)
- Each update is a **full replace** — the client replaces the session plan entirely
- Empty `entries: []` hides `PlanPanel`

Termul does **not** normalize vendor extensions (e.g. Cursor `cursor/update_todos`). Agents must comply with the spec for plans to appear.

Implementation:

| Layer | Path |
|-------|------|
| Rust | `SessionUpdate::Plan` → `acp:plan_update` (`src-tauri/src/acp/client.rs`) |
| Store | `plans[sessionId]` full replace (`src/renderer/stores/acp-store.ts`) |
| UI | `PlanPanel` + `PlanSupportHint` (`src/renderer/components/chat/`) |

Compliance metadata: `src/renderer/lib/agents/acp-plan-compliance.ts`

## Registry audit (37 bundled agents)

Status key:

| Status | Meaning |
|--------|---------|
| `unknown` | Not verified; plan may appear if agent emits standard updates |
| `standard` | Verified standard `session/update` plan |
| `non_standard_extension` | Known to use a non-spec extension instead of plan |
| `unsupported` | Documented: adapter does not emit plans |

### Verified / documented

| Registry id | Status | Notes |
|-------------|--------|-------|
| `cursor` | `non_standard_extension` | Uses `cursor/update_todos`, not spec plan. PlanPanel empty until Cursor CLI emits standard plan. |
| `pi-acp` | `unsupported` | [pi-acp docs](https://github.com/victor-software-house/pi-acp): plan updates not emitted before tool execution. |

### Test targets (user environment)

| Registry id | Status | Notes |
|-------------|--------|-------|
| `opencode` | `unknown` | ACP transport present; plan emission not verified in Termul. Multi-step prompts should be re-tested after agent-side compliance. |

### All other bundled agents (`unknown`)

`agoragentic-acp`, `amp-acp`, `auggie`, `autohand`, `claude-acp`, `cline`, `codebuddy-code`, `codex-acp`, `cortex-code`, `corust-agent`, `crow-cli`, `deepagents`, `devin`, `dimcode`, `dirac`, `factory-droid`, `fast-agent`, `gemini`, `github-copilot-cli`, `glm-acp-agent`, `goose`, `grok-build`, `junie`, `kilo`, `kimi`, `minion-code`, `mistral-vibe`, `nova`, `poolside`, `qoder`, `qwen-code`, `sigit`, `stakpak`, `vtcode`

Update `KNOWN_COMPLIANCE` in `acp-plan-compliance.ts` when an agent is verified.

## Acceptance scenario

1. Open an agent chat session for an agent with `standard` compliance (once verified).
2. Send a multi-step prompt.
3. `PlanPanel` shows entries with `pending` / `in_progress` / `completed` as the agent emits standard plan updates.
4. Agents marked `non_standard_extension` or `unsupported` show `PlanSupportHint` instead when no plan is present.

## Agent vendor guidance

To support execution plans in Termul (and any spec-compliant ACP client):

1. Emit `session/update` notifications with `sessionUpdate: "plan"`.
2. Include the **complete** entry list on every update.
3. Do not rely on client-specific extensions for plan visibility.

Reference: https://agentclientprotocol.com/protocol/v1/agent-plan
