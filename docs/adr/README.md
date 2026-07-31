# Architecture Decision Records

This directory contains a small, explicitly reconstructed record for the ACP
references that are otherwise broken in the source tree. These files are not
the missing historical originals and must not be read as evidence of the
original authors' rationale.

## Status and provenance

- **Status:** Reconstructed; current implementation summary only.
- **Date:** Unknown for the original records.
- **Author:** Unknown for the original records.
- **Provenance:** Issue #357, the current `dev` tree, and the source comments and
  types cited below. No authoritative ADR-003 or ADR-004 original was found in
  the current tree, the `origin/dev` tree, or the reachable git path history
  checked for ADR filenames. Historical rationale is therefore intentionally
  not supplied.

## Records

| Record | Scope | Status |
| --- | --- | --- |
| [ADR-003 — ACP Agent Chat UI Architecture](./adr-003-acp-agent-chat-ui-architecture.md) | ACP-backed Agent Chat boundary and current session behavior | Reconstructed |
| [ADR-003 P0 — Rust ACP Core](./spec-adr-003-p0-rust-acp-core.md) | Rust ACP runtime P0 scope and protocol integration | Reconstructed |
| [ADR-004 — ACP/CLI Agent Registry Split](./adr-004-acp-cli-agent-registry-split.md) | Current behavior documented only for sections 4.2–4.6 | Reconstructed |

## Validation evidence

The following checks were used before reconstruction:

```text
git ls-tree -r --name-only HEAD -- docs/adr
# no output

git ls-tree -r --name-only origin/dev -- docs/adr
# no output

git log --all -- docs/adr '*/adr-003*' '*/adr-004*' '*spec-adr-003*'
# only broad historical docs-folder commits; no authoritative ADR file path
```

The direct source references now resolve to committed paths under this
directory. The records were also checked against the live source files named in
their validation notes. This is a path and implementation-consistency check,
not proof of historical intent.

## Unresolved references

This minimal restoration does **not** fabricate records that were not requested
or supported by the available evidence:

- `docs/adr/0001-agent-chat-file-attachment-transport.md` is still referenced
  by `src/renderer/components/chat/chat-attachments.ts` and
  `src/renderer/components/chat/use-composer-attachments.ts`, but its original
  record is unavailable.
- ADR-002 / `0002` is referenced by the chat-history documentation, but its
  original record is unavailable.
- Generic `ADR-003` comments without a numbered subsection are covered here only
  as current behavior; their historical rationale remains unresolved.
- No claim is made about ADR-003 or ADR-004 sections not supported by an
  explicit source citation or the current implementation evidence listed in
  these records.

When an authoritative record is recovered, it should replace or supersede these
reconstructions rather than being merged with invented rationale.
