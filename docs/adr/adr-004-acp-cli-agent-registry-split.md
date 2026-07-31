# ADR-004: ACP/CLI Agent Registry Split

- **Status:** Reconstructed current behavior for sections 4.2–4.6 only; not the historical original
- **Date:** Unknown (original record unavailable)
- **Author:** Unknown (original record unavailable)
- **Provenance:** Issue #357 and the current renderer/Rust source comments,
  types, tests, and implementation. Historical rationale is unknown.

> Section 4.1 and any other ADR-004 section are intentionally omitted. The
> following is evidence-backed current behavior, not a reconstruction of
> missing rationale.

## ADR-004.2 — executable and argument resolution

The terminal-native launch path and ACP configuration reuse the PTY executable
resolver where needed. On Windows, npm-style `.cmd`/`.bat` shims can be resolved
to a real program plus prepended script arguments. On non-Windows systems, a
bare executable may be resolved against the refreshed PATH before ACP spawning.

Arguments remain discrete argv elements; the launch path does not shell-
interpolate the prompt. If the specialized resolver cannot resolve a command,
the current code preserves a fallback command so the eventual spawn error stays
observable. These behaviors are implemented in `src-tauri/src/pty/manager.rs`,
`src-tauri/src/pty/windows.rs`, and `src-tauri/src/acp/config.rs`.

## ADR-004.3 — app-owned terminal-agent launch registry

The renderer owns a per-agent launch table for terminal-native CLI agents. A
`TerminalAgentDefinition` records the command, static `baseArgs`, prompt mode,
optional prompt flag, environment requirements, identity, and whether the entry
is built in. The launch table is authoritative for the interactive TUI
invocation; it is not derived from an ACP server distribution record.

Built-in entries currently include Claude Code, Codex, Cursor, Gemini CLI,
OpenCode, and pi. User-defined entries use the same launch metadata shape. The
renderer tests cover the launch conventions currently encoded in the table.

## ADR-004.4 — descriptive metadata and restoration

Terminal records can retain descriptive agent metadata, including agent
identity, program, and base arguments. The seed prompt is not persisted as a
restoration command. Restoring an agent terminal re-spawns the configured agent
program and reapplies the descriptive metadata so the restored tab remains
identified as an agent terminal.

This behavior is implemented by the terminal autosave/restore hooks and the
agent-launch and terminal stores. It concerns terminal-native CLI agents, not
ACP Agent Chat session resume.

## ADR-004.5 — agent launch entry point

The workspace command bar exposes a `Launch Agent` entry, and the pane-level
picker distinguishes agent launch from a plain terminal launch. The agent
picker overlay is pane-level and covers the tab bar/content area while open.
The launch orchestration then uses the app-owned registry from ADR-004.3.

Current evidence is in `WorkspaceLayout.tsx`, `PaneContent.tsx`,
`src/renderer/lib/agent-launch.ts`, and the related agent-launch tests.

## ADR-004.6 — opt-in ACP Registry identity and discovery

Termul may fetch the public ACP Registry on explicit user action for identity
and discovery only. The Rust side performs a read-only GET, caches the catalog,
and reports `network`, `cache`, or `empty` source state. The default bundled
experience remains offline; a transient network failure falls back to cache or
an empty catalog.

Registry entries expose identity fields such as id, name, description, website,
and icon. The registry `distribution` field is intentionally not exposed as a
terminal launch command: it describes an ACP-server invocation and is not the
interactive TUI command. The app-owned launch table remains authoritative for
`command`, `baseArgs`, and `promptMode`. Registry identity may be linked by
`registryId`; remote icons are not promoted into a bundleless definition.

The fetch is implemented in `src-tauri/src/agent_registry.rs` and exposed by
the renderer wrapper in `src/renderer/lib/agents/acp-registry-catalog.ts`.
Project data and credentials are not part of the registry request.

## Validation note

The sections above were checked against:

- `src-tauri/src/pty/manager.rs`, `windows.rs`, and `acp/config.rs` (4.2);
- `src/renderer/lib/agents/agent-registry.ts` and its tests (4.3);
- `src/renderer/hooks/useTerminalAutoSave.ts`,
  `use-terminal-restore.ts`, `lib/agent-launch.ts`, and terminal metadata types
  (4.4);
- `src/renderer/layouts/WorkspaceLayout.tsx` and
  `components/workspace/PaneContent.tsx` (4.5); and
- `src-tauri/src/agent_registry.rs`, `src-tauri/src/commands.rs`, and
  `src/renderer/lib/agents/acp-registry-catalog.ts` (4.6).

The check confirms current behavior and reference paths. It does not establish
historical intent, and no authoritative ADR-004 original was found.

## Unresolved

ADR-004.1 and any ADR-004 sections beyond 4.6 are not reconstructed here.
References to ADR-001 and ADR-002 remain unresolved; see
[`README.md`](./README.md).
