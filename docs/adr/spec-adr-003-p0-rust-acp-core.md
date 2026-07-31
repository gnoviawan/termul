# ADR-003 P0: Rust ACP Core Specification

- **Status:** Reconstructed from current implementation; not the historical original
- **Date:** Unknown (original record unavailable)
- **Author:** Unknown (original record unavailable)
- **Provenance:** Issue #357, the ACP module manifest/module documentation, and
  the current Rust ACP implementation. Historical rationale is unknown.

> This is a reconstructed specification of the P0 boundary. It intentionally
> does not present later UI work or an invented historical design narrative as
> part of the original specification.

## Scope

P0 is the Rust runtime layer for ACP-backed agents. Its observable
responsibilities are:

- spawn a configured ACP coding-agent subprocess;
- complete the ACP JSON-RPC initialization/handshake;
- create and manage ACP protocol sessions;
- send prompt turns and stream agent updates;
- handle protocol permissions and optional client capabilities; and
- bridge lifecycle/session events to the renderer over Tauri IPC.

The React Agent Chat UI consumes this runtime. The terminal-native CLI-agent
launcher is a separate route and is summarized in ADR-004.

## Protocol integration

The crate uses `agent-client-protocol` version `0.12` with the
`unstable_session_model` and `unstable_session_usage` features. The runtime uses
the crate's `AcpAgent`/`Stdio` transport. A separate
`agent-client-protocol-tokio` dependency is deliberately not used because the
current manifest notes that it targets ACP 0.11 and would introduce a second,
incompatible protocol copy.

The configured command and arguments are passed as a discrete argv vector. The
current configuration path refreshes the process PATH and resolves executable
paths before spawning; Windows command shims are handled by the shared PTY
resolver where applicable.

## Runtime surface

`src-tauri/src/acp/mod.rs` exposes the ACP modules and re-exports the manager,
configuration identifiers, project registry, and session-persistence types used
by the Tauri wiring. The manager owns the spawned-agent/session lifecycle; the
renderer-facing commands and event types are kept in the ACP module and its
command/event submodules.

The runtime is backend-only in this P0 description. UI details, resume policy,
attachments, and history presentation belong to the Agent Chat integration and
are not silently treated as part of the missing original specification.

## Validation note

The current source validates this summary at:

- `src-tauri/src/acp/mod.rs` for the P0 boundary and module surface;
- `src-tauri/Cargo.toml` for the ACP crate/version/features and transport note;
- `src-tauri/src/acp/config.rs` for command, environment, PATH, and argv
  handling; and
- `src-tauri/src/acp/{client,events,manager,session}.rs` for protocol lifecycle
  responsibilities.

This validation confirms current implementation facts only. The original author,
date, approval record, and rationale were not found in git or `origin/dev`.

## Unresolved references

The original ADR-003 P0 document is unavailable. This reconstruction does not
claim to define unreferenced P1+ requirements or historical trade-offs.
