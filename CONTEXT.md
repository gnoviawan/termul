# Context

## Glossary

- **Agent Chat**: A chat-thread workspace surface for ACP-backed coding agents. It does not launch terminal-native CLI agents.
- **ACP Agent**: A supported Agent Client Protocol configuration derived automatically for Agent Chat; Application Preferences only shows availability/status.
- **Model Picker**: The new-thread control that selects an ACP Agent and, when advertised by that ACP session, one of its model config values.
- **Variant Picker**: The control for an ACP session's `thought_level` config option, such as low, medium, high, or max thinking depth.
- **Agent Picker**: The control for ACP session modes, such as Build or Plan, within the selected ACP Agent.
- **Attachment**: A file or image the user stages in the Agent Chat composer before sending. On send, each Attachment becomes one ACP content block.
- **Resource Link**: An ACP `resource_link` content block that references a file by its filesystem path; the ACP Agent opens and reads the file with its own tools. Produced when the file's path is known (the OS file picker). No prompt capability is required.
- **Embedded Resource**: An ACP `resource` content block that carries a file's inline text content. Produced when only the file's bytes are known and no path exists (drag-and-drop or paste). Requires the ACP Agent's `embeddedContext` prompt capability.
- **File Mention**: An `@`-prefixed token typed mid-text in the Agent Chat composer that opens a codebase filename-search picker scoped to the session's working root. Selecting a result stages a `file-ref` Attachment (an ACP `resource_link`) and removes the token from the composer text. A discovery channel for Attachments — not a separate transport or content-block type.
_Avoid_: file reference, mention-link, inline file chip
- **Chat History Scope**: The `(projectId, cwd)` pair that partitions persisted Agent Chat sessions. A session is visible only when both the active `Project.id` and the active working directory (main checkout path or a `Worktree.path`) match the session's stored values. See ADR 0002.
- **Chat History Wipe Migration**: A one-shot, first-run-after-upgrade step that clears all pre-existing `acp/sessions/*` records because they predate the `projectId` field and cannot be backfilled. Gated by the `acp/sessions/migrated-v2` flag.
