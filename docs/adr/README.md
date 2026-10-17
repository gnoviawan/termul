# Architecture decision records

This directory holds the architecture decision records (ADRs) for Termul.
Add an entry to the table when you add an ADR.

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0004](./0004-claude-accounts-linked-config-dirs.md) | Claude accounts use linked config directories | Accepted |

## Missing ADRs

Source comments also cite records that are not in the repository. Issue #357
tracks their restoration.

- ADR-002, ADR-003, ADR-004, and ADR-007. ADR-004 (with its ADR-004.x
  sections) is a different record from ADR-0004 above.
- ADR-0001 and ADR-0002.
- ADR 0002 and ADR 0003, written with a space. These cover chat-history
  scoping and the file-mention picker, and are different records from
  ADR-0002 and ADR-0003.

`.gitignore` excluded this directory until #1180, which is the likely reason
these records are missing.
