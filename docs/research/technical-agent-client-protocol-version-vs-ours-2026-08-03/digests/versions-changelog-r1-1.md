# Digest: ACP Rust SDK crate — version lineage & changelog (round 1)

Source: crates.io API + GitHub releases + v2.0 migration guide.
Accessed: 2026-08-03.

## Version lineage (newest first, key milestones)

- 2.0.0  (2026-07-23) — LATEST. Coordinated major release. Wire schema v1 unchanged; SDK API breaking changes.
- 1.3.0  (2026-07-20) — latest 1.x. Added v1+v2 dual routers; fixed EOF, stderr bounding, process-group kill on ChildGuard drop.
- 1.2.0  (2026-07-07)
- 1.1.0  (2026-07-06)
- 1.0.1  (2026-06-29)
- 1.0.0  (2026-06-24) — bumped protocol schema to 1.1.0.
- 0.15.1 (2026-06-22)
- 0.15.0 (2026-06-19)
- 0.14.0 (2026-06-05)
- 0.13.1 (2026-06-01)
- 0.13.0 (2026-06-01)
- 0.12.1 (2026-05-17) — ***OUR VENDORED VERSION*** (with Termul patch to acp_agent.rs to hide Windows console window).
- 0.12.0 (2026-05-16)

77 versions total; none yanked.

## v1.0.0 (2026-06-24) — what crossed 0.12 → 1.0
- Bumped protocol schema to 1.1.0.
- "Handle large future sizes in run_until".
- Release notes are thin; the breaking-change density is low here. The real API churn is between 0.13–0.15 and at 2.0.

## v1.3.0 (2026-07-20) — latest 1.x, notable fixes
Added:
- (unstable-v2) routers for supporting both v1 and v2 at once.
Fixed:
- (acp) preserve builder auto traits for on_close.
- (acp) Handle incoming EOF correctly.   ← relevant to Termul agent subprocess lifecycle
- (acp) Bound stderr capture memory.      ← relevant: unbounded stderr was a leak risk
- kill the agent's whole process group when ChildGuard drops.  ← HIGHLY relevant to Termul on Windows (orphaned agent children)
- (unstable-v2) Require matching v2 protocol negotiation.

## v2.0.0 (2026-07-23) — breaking SDK changes; wire schema v1 UNCHANGED
Quote: "Version 2.0 keeps the stable ACP v1 wire schema unchanged while making coordinated breaking changes to the Rust SDK APIs and low-level transport boundary."

Breaking:
- `Channel` carries batch-aware `TransportFrame`; `Lines`/`ByteStreams` fields private → construct with `new`.
- JSON-RPC: notifications never answered; `ResponseRouter` uses `route*`; typed request IDs borrowed; `TypeNotification` role-independent.
- Handler/routing: `DynamicHandlerGuard` (no Clone, must_use); `with_runner` (was `with_responder`); `if_dispatch*` (was `if_message*`).
- MCP-over-ACP: feature-gated schema-native `McpServer::Acp`, `mcp/connect`, `mcp/message`, `mcp/disconnect`. SDK-local wire types + `acp:` HTTP declarations removed.
- **`AcpAgent` now uses `AcpAgentConfig`** (not the MCP `McpServer` wire type). `server()`/`into_server()` → `config()`/`into_config()`. Deprecated Zed constructors + Gemini convenience constructor removed. JSON env changes from `[{name,value}]` to string map.  ← touches the SAME file Termul patches
- Ordered response-callback dispatch (behavioral change).
- `ConnectionTo::attach_session` no longer public; use `build_session*` / `SessionBuilder::on_session_start`.
- Draft v2 schema: semantic newtypes (AbsolutePath, MediaType, IDs…); `DiffPatch.diff`→`text`; terminal state types; fallible generic conversions.

Added:
- Incoming JSON-RPC batch support on stable v1 and draft v2.
- `SentRequest::map` accepts arbitrary output (one-shot closures, non-'static with block_task).

Fixed:
- Session/proxy route ordering; double-response prevention; batch boundary preservation across adapters/routers/tracing; malformed-response handling; protocol-negotiation edge cases; `MatchDispatchFrom` retry state.

Migration guide: https://agentclientprotocol.github.io/rust-sdk/migration_v2.0.html

## Termul-specific relevance (project context — shapes priority, NOT truth)
- Vendored 0.12.1 with a patch in `vendor/agent-client-protocol/src/acp_agent.rs` to hide the Windows console window on spawn.
- Features enabled: `unstable_session_model`, `unstable_session_usage`.
- Uses `AcpAgent` spawn path (`src-tauri/src/acp/manager.rs`), MCP-over-ACP (`useAcpMcp`), session usage events.
- v2.0 reworks `AcpAgent` → `AcpAgentConfig`: the Termul console-hiding patch must be RE-APPLIED on the new design (different surface: `AcpAgentConfig::new`, `command()`/`arguments()`/`environment()`).
- v1.3.0 process-group kill on `ChildGuard` drop + EOF handling are directly relevant to Termul's Windows agent-spawn reliability.

## Lead-following (leads worth chasing)
- Full per-version changelog between 0.13.0 and 0.15.1 (the gap between ours and 1.0) — release pages 2+.
- Whether `unstable_session_model` / `unstable_session_usage` graduated to stable in 1.x or 2.0.
- rmcp 1.x → 2.x dependency jump (Termul pins rmcp 1.2.0; v2.0 SDK needs rmcp 2.x via agent-client-protocol-rmcp 3.x).
