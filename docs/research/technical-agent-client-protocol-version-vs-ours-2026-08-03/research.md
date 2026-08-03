# Agent Client Protocol — SDK crate vs spec: is updating worth it?

_Research run, 2026-08-03. Headless/YOLO. Type: technical. Decision: should Termul update its `agent-client-protocol` Rust crate from the vendored 0.12.1?_

## TL;DR

You're conflating two version numbers that are **not** the same thing:

| Thing | Version | What it tracks |
|---|---|---|
| **ACP spec / wire protocol** | **v1** (stable) | the JSON-RPC protocol itself — `agentclientprotocol.com/protocol/v1/...` |
| **`agent-client-protocol` Rust SDK crate** | **2.0.0** (latest); ours is **0.12.1** | the Rust SDK library, an entirely separate artifact from the spec |

So "they're on v1, ours is 0.xx" is a category error. The spec is v1 and the SDK crate never matched the spec number — the crate went 0.0.x → 0.15 → 1.x → 2.0 on its own release cadence. **v2.0 of the crate explicitly keeps the stable ACP v1 wire schema unchanged.** Your wire protocol is current; your SDK library is two majors behind.

**Recommendation: yes, update — but in two steps, not one.** Go to **1.3.0 first** (low-churn, high-value fixes for your exact pain points), then evaluate 2.0.0 as a separate, larger migration. Details below.

---

## 1. Where we are

Termul vendors `agent-client-protocol` **0.12.1** (released 2026-05-17) at `src-tauri/vendor/agent-client-protocol/`, with one Termul-specific patch in `src-tauri/src/acp_agent.rs` to hide the console window when spawning an agent subprocess on Windows (`src-tauri/Cargo.toml:170`). It pins `agent-client-protocol-schema =0.13.2` and enables `unstable_session_model` + `unstable_session_usage` (`src-tauri/Cargo.toml:84`).

The wire protocol the vendored crate speaks is **`ProtocolVersion::V1`** (`src-tauri/src/acp/manager.rs:1926`, `vendor/.../concepts/connections.rs:49`) — i.e. the current stable spec. Nothing on the wire is stale.

## 2. What's out there (crates.io + GitHub releases, accessed 2026-08-03)

The crate has shipped 77 versions, none yanked. The relevant arc since our pin:

```
0.12.1 (ours)  → 0.13.0/0.13.1 → 0.14.0 → 0.15.0/0.15.1 → 1.0.0 → 1.0.1 → 1.1.0 → 1.2.0 → 1.3.0 → 2.0.0 (latest)
```

- **1.0.0** (2026-06-24): bumps protocol schema to 1.1.0; "handle large future sizes in run_until". Thin release notes; the breaking density here is low.
- **1.3.0** (2026-07-20, latest 1.x): *(unstable-v2)* routers for supporting v1+v2 at once; fixes — **handle incoming EOF correctly**, **bound stderr capture memory**, **kill the agent's whole process group when `ChildGuard` drops**, preserve builder auto traits for `on_close`, require matching v2 protocol negotiation.
- **2.0.0** (2026-07-23, latest): coordinated major release across the workspace. *Quote: "keeps the stable ACP v1 wire schema unchanged while making coordinated breaking changes to the Rust SDK APIs and low-level transport boundary."* Migration guide: <https://agentclientprotocol.github.io/rust-sdk/migration_v2.0.html>.

## 3. Why this matters for Termul specifically

Three facts from the changelog map directly onto Termul's code:

1. **v1.3.0's `ChildGuard` process-group kill + EOF handling** are exactly the reliability gaps you have when spawning ACP agent subprocesses on Windows. Orphaned child processes and dropped-EOF hangs are the class of bug this fixes. This alone is a strong argument for moving to 1.3.0.

2. **v2.0 reworks `AcpAgent` into `AcpAgentConfig`** — and `acp_agent.rs` is *the exact file Termul patches*. The migration guide is explicit: `AcpAgent` no longer reuses the MCP `McpServer` wire type; `server()`/`into_server()` → `config()`/`into_config()`; the deprecated Zed constructors and the Gemini convenience constructor are removed; JSON env vars go from `[{name,value}]` to a string map. Your console-hiding patch survives conceptually (it's about the spawned subprocess) but must be **re-applied onto a different API surface**.

3. **v2.0 changes MCP-over-ACP** from the SDK-local `acp:` HTTP declaration hack to feature-gated schema-native `McpServer::Acp` + `mcp/connect` / `mcp/message` / `mcp/disconnect`. Termul has a `useAcpMcp` hook (`src/renderer/App.tsx:108`) and the docs describe an MCP flow, so this is in scope — but only if you actually wire MCP servers *through* ACP rather than standalone.

Two Termul-relevant *unstable_* features are still feature-gated in 2.0 (`unstable_session_model`, `unstable_session_usage` appear in the vendored Cargo.toml feature list and remain gates in 2.0), so updating does not force you off them — they carried forward.

## 4. The two-step recommendation

### Step A — update to 1.3.0 (do this soon; low risk, high value)
- Re-vendor at 1.3.0, re-apply the Windows console-hiding patch to `acp_agent.rs` (the `AcpAgent` API in 1.x is still the MCP-`McpServer`-based shape, so the patch site should be familiar).
- Pay the 0.12→1.0 schema bump (schema 0.13.2 → 1.1.0) and any 0.13–0.15 API churn — read releases pages 2–5 for the intermediate breaking notes. The 1.0.0 notes are thin, so churn here is likely small-to-moderate, but verify against the per-release pages.
- You pick up the v1.3.0 reliability fixes (process-group kill, EOF, stderr bounding) that directly improve your Windows agent-spawn path.
- Wire protocol stays v1 — no agent-side compatibility risk.

### Step B — evaluate 2.0.0 as its own project (larger, schedule it deliberately)
- Real migration, not a bump. Work through the official migration guide section by section; the `AcpAgent`→`AcpAgentConfig`, transport `Channel`/`TransportFrame`, handler/routing renames, and `attach_session` removal are the load-bearing changes.
- Re-apply the console-hiding patch on the new `AcpAgentConfig` surface (`config()`/`command()`/`arguments()`/`environment()`).
- Upgrade `rmcp` 1.2.0 → 2.x *if* you use `agent-client-protocol-rmcp` (the rmcp integration moves to 3.x and pulls rmcp 2.x as a public dep). Standalone rmcp use is unaffected.
- Upside: JSON-RPC batch support, native MCP-over-ACP transport, ordered-dispatch correctness fixes, and you're on the maintained line (1.x will go to security-fix-only; 2.x is where new work lands).
- This is a "tens of minutes of migration, plus testing" task, not a casual bump — don't bundle it into another change.

## 5. What I could not verify (open questions)
- Per-release breaking changes between 0.13.0 and 0.15.1 (the gap from our pin to 1.0). The 1.0.0 release page is thin; the intermediate churn lives on releases pages 2–5, which I did not fully crawl. **Before Step A, read those pages** — they determine whether 0.12→1.3 is a day or a week.
- Whether `unstable_session_model` / `unstable_session_usage` are slated to graduate to stable in a 2.x point release. They remain feature-gated in 2.0.0; no announcement of stabilization found in the migration guide.
- Whether any agent in the bundled registry snapshot (e.g. `@agentclientprotocol/claude-agent-acp@0.64.1`, `@agentclientprotocol/codex-acp@1.1.9` in `src/renderer/assets/agent-icons/acp/agents.json`) has tightened its own protocol-version negotiation such that an SDK bump changes observed behavior. The registry agents speak wire v1; SDK version should be transparent to them, but re-test the plan-emission compliance tier (`docs/acp-agent-plan-compliance.md`) after any bump.

## 6. Sources
- crates.io — `agent-client-protocol` crate metadata + full 77-version history. Accessed 2026-08-03.
- GitHub — `agentclientprotocol/rust-sdk` releases: v1.0.0, v1.3.0, v2.0.0 (and coordinated crate releases). Accessed 2026-08-03.
- v2.0 migration guide — <https://agentclientprotocol.github.io/rust-sdk/migration_v2.0.html>. Accessed 2026-08-03.
- Termul source — `src-tauri/Cargo.toml`, `src-tauri/vendor/agent-client-protocol/Cargo.toml`, `src-tauri/src/acp/manager.rs`, `docs/acp-agent-plan-compliance.md`, `CONTEXT.md`, `CLAUDE.md`.
