# ADR-003: ACP Agent Chat UI Architecture

- **Status:** Reconstructed from current implementation; not the historical original
- **Date:** Unknown (original record unavailable)
- **Author:** Unknown (original record unavailable)
- **Provenance:** Issue #357, current `dev` source, `CONTEXT.md`, and the
  validation references below. Historical rationale is unknown.

> This document restores a navigable reference target. It records observable
> boundaries and behavior only; it does not claim to recover the original
> decision process.

## Context

Termul has two different agent surfaces:

- **Agent Chat** is an ACP-backed chat-thread workspace surface. It is not a
  terminal-native CLI-agent launcher.
- **Terminal-native agents** run through the ordinary terminal/PTY route and are
  described by ADR-004's current implementation summary.

The Rust ACP module owns the agent subprocess and protocol lifecycle. The
renderer owns the Agent Chat surface and consumes the runtime through Tauri IPC.

## Current architecture

1. The ACP runtime launches a configured agent subprocess, completes the ACP
   JSON-RPC initialization, creates and manages protocol sessions, streams turn
   updates, and bridges events to the renderer.
2. Agent Chat presents ACP sessions as chat threads. A new thread can select an
   ACP Agent and, when advertised by that ACP session, a model configuration
   value, a `thought_level` variant, and a session mode such as Build or Plan.
3. A staged attachment becomes one ACP content block. A known filesystem path is
   sent as a `resource_link`; bytes without a path are sent as an embedded
   `resource` when the agent advertises `embeddedContext`.
4. Persisted chat visibility is partitioned by `(projectId, cwd)`. Existing
   pre-migration sessions are cleared once because their project identity could
   not be backfilled.
5. Agent failures do not silently respawn the agent. A user-initiated retry is
   the recovery path, and disconnect events are surfaced to the renderer.

These statements describe the current code and documented glossary. They are
not assertions about why the historical design was selected.

## Numbered references preserved from source comments

### ADR-003.4 — ACP configuration options take precedence over legacy modes

The slash-menu model exposes ACP configuration options ahead of legacy mode
entries when building the command/configuration choices. The source comment
identifies this behavior as `ADR-003.4`; no original rationale was recovered.

### ADR-003.7 — reopen persisted sessions according to live capability state

The resume policy is a pure renderer-side decision for reopening a persisted
ACP session. A live session can use the protocol's load/resume path only when
the currently connected agent and its advertised capabilities support it. When
that live path is unavailable, persisted local history remains available as a
read-only transcript rather than silently claiming that a live session was
restored. Reconnecting or retrying is explicit.

The precise historical policy text is unavailable; this section records the
behavior named by `acp-resume-policy.ts` and the current ACP store flow.

## Boundaries and consequences observed today

- The UI and Rust runtime communicate through typed ACP/Tauri contracts rather
  than making the renderer responsible for subprocess management.
- ACP session events, permissions, terminal capability, and protocol errors are
  surfaced through the runtime event bridge. Capability checks are enforced by
  the runtime before using optional client features.
- A chat session's persisted identity includes its project and working
  directory scope. It is not a global transcript shared by unrelated projects
  or worktrees.
- The no-silent-respawn behavior makes an agent crash visible and avoids
  presenting a new process as a continuation without an explicit user action.

## Validation note

This reconstruction was checked against the current `dev` tree at:

- `src-tauri/src/acp/mod.rs`, `client.rs`, `events.rs`, `manager.rs`, and
  `session_persistence.rs` for the Rust lifecycle and event boundary.
- `src/renderer/stores/acp-store.ts` and
  `src/renderer/lib/acp-resume-policy.ts` for retry/resume behavior.
- `src/renderer/components/chat/slash-menu-model.ts` for ADR-003.4.
- `src/renderer/components/chat/AgentChatPanel.tsx` for user-initiated retry.
- `CONTEXT.md` for Agent Chat, content-block, and chat-history terminology.

The validation establishes that the referenced paths and described behavior
exist in the current tree. It does not recover missing historical rationale.

## Unresolved

ADR-001, ADR-002, and any unnumbered historical ADR-003 rationale remain
unavailable. See [`README.md`](./README.md).
