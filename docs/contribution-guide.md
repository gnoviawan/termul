# Termul Manager - Contribution Guide

**Date:** 2026-05-09

## Overview

This guide summarizes the project’s documented contribution workflow and repository conventions.

## Prerequisites

- Bun 1.3+
- Git
- Rust toolchain and platform-specific Tauri dependencies for running/building the desktop app

## Standard Contribution Flow

1. Fork the repository
2. Clone your fork
3. Install dependencies with `bun install`
4. Create a feature branch
5. Make changes
6. Run validation commands
7. Open a pull request

## Recommended Commands

```bash
bun install
bun run test
bun run typecheck
bun run lint
bun run dev
```

## Branching

Example branch naming from the project guide:

```bash
git checkout -b feature/your-feature-name
```

## Pull Request Expectations

PRs should include:

- a clear description of changes
- related issue links when applicable
- screenshots for UI changes
- testing steps

## Commit Convention

The project follows conventional commit style.

Allowed examples include:

- `feat:`
- `fix:`
- `docs:`
- `style:`
- `refactor:`
- `test:`
- `chore:`

The PR validation workflow also accepts:

- `perf:`
- `build:`
- `ci:`
- `revert:`

The PR title check requires the subject to start with lowercase.

## Code Style Expectations

- Use TypeScript for new renderer code
- Follow existing patterns
- Keep components focused and single-purpose
- Use meaningful names
- Add comments only when logic is not self-evident

## Testing Expectations

- Add tests for new functionality
- Ensure existing tests pass before submission
- Place tests next to the code they validate

## Size and Splitting Rules

Following the October 2026 codebase-slimdown campaign (PRs #786–#816: −4,102 net code lines, 77 test-mod extractions, dead-code sweeps, god-file splits), the project enforces structural size limits on new and modified code:

### File-size ceiling (~800 prod code lines)

No production file should exceed roughly 800 code lines (comments and blanks excluded, tokei-style). When a file crosses the ceiling, split it before growing it further. Vendored/generated bundles (e.g. `src-tauri/resources/agentation-toolbar.js`) and data files are exempt. Splits are **move-only refactors** — move code, never rewrite behavior in the same change.

### Split patterns by type

| What | Pattern | Reference |
|---|---|---|
| Rust single-file module | `<name>.rs` → `<name>/` dir: `mod.rs` (types/hub) + domain modules + `tests.rs`. `pub use` re-exports in `mod.rs` keep `crate::` paths unchanged for callers. | `src-tauri/src/web/ws/`, `src-tauri/src/commands/`, `src-tauri/src/acp/manager/` |
| Rust crate root | `#[path = "..."]` for special cases (`lib.rs` root) | `src-tauri/src/lib_tests.rs` |
| TS store | one zustand slice per domain + `types.ts`/`helpers.ts`/`shared-state.ts` | `src/renderer/stores/acp-store/` |
| TS store tests | one file per top-level `describe` + shared `testkit.ts` | `src/renderer/stores/acp-store/*.test.ts` |
| Large component | leaf components (sections/tabs) + extracted hooks, parent keeps wiring; export path preserved via thin re-export shim | `GitPanel`, `AppPreferences`, `ProjectSidebar`, `WorkspaceTabBar` |
| Cross-cutting hooks | extract to sibling hook files, keep component JSX lean | `ConnectedTerminal`, `AgentLauncher` |

### Rust test placement

Unit tests live in a sibling `tests.rs` (or `<name>_tests.rs` for crate-root/special layouts) — **not** in inline `#[cfg(test)] mod tests` tails inside production files. One test mod per file; place it as a sibling of the module it tests. This reverses the earlier in-file convention: the October campaign extracted 77 such tails (~35k lines out of production files), and `acp/tests.rs` documents the landed decision.

### Shared helpers (no local copies)

- `src/renderer/lib/ipc/tauri.ts` — `invokeIpc` (was duplicated across 10 adapters)
- `src/renderer/lib/ipc/http.ts` — `serverBase`/`parseBody`/`networkError` (was duplicated across 7 web adapters)
- `src/renderer/lib/test-utils/` — `mockTerminal`, store-state, and ACP test factories (was 29 local `mockTerminal` definitions)

Do not re-define these in adapters or test files; import the canonical helper. The `parity-checklist.test.ts` suite pins the transport contract.

### Post-split checklist

1. Re-grep extracted symbols for orphaned imports — splits orphan their own consumers (observed: `useTerminals`, `CommandChip`, the `XTerminal`/`use-xterm` chain went dead when their importers were removed by #812).
2. Keep each PR ≤50 changed files (see PR constraints above); split larger work into stacked PRs.
3. Verify: `bun run typecheck` (node/web/test), `cargo check --tests`, `cargo clippy --all-targets`, and the domain's own test files plus `parity-checklist.test.ts`.

### Known current residuals (2026-10-03)

- Watch list (next-tier, no action required until they grow): `acp-store/slices/session.ts` 1,459 · `AgentLauncher.tsx` 1,522 · `ConnectedTerminal.tsx` 1,393 · `FileExplorer.tsx` 1,259 · `use-terminal-restore.ts` 1,152 · `workspace-store.ts` 1,151

- `src-tauri/src/lib.rs` 1,522 — deferred pending feature merges, spec plans exist (`layouts/WorkspaceLayout.tsx` was split in #993 story 1)
- `browser_automation/mod.rs` inline test tail (141 lines) — extract per convention
- `terminal-factory.ts` duplicates `shouldUseWebglRenderer` from `use-webgl-recovery.ts`

### Exclusions from size accounting

`brag-output*`, `target/`, `landing/`, vendored resources, and `_bmad-output/` are excluded from LOC accounting and lint scope.

## Documentation Expectations

- Update `README.md` when features change user-facing behavior
- Add JSDoc for public APIs where helpful
- Update type definitions when contracts change

## Repository Structure Awareness

Contributors should understand the main structure:

- `src/renderer/` — frontend UI and orchestration
- `src/shared/` — shared contracts
- `src-tauri/` — native runtime and packaging
- `docs/` — operational and generated documentation

## CI Validation

PR validation runs:

- PR title semantic check
- lint
- typecheck
- tests
- Rust check/test/clippy
- Tauri frontend build verification

A successful PR should be compatible with those checks before submission.

## Release / Maintainer Notes

Maintainers creating releases should ensure aligned versions in:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

They should also verify signed updater assets and release publishing steps.

## Security / Care Areas

- Changes touching updater/signing need extra caution
- Terminal runtime changes span Rust + renderer layers
- Browser annotation/webview changes affect one of the more specialized subsystems
- Persisted env vars currently include a noted future security-hardening area for secret storage

---

_Source summary derived from `CONTRIBUTING.md` and repository workflows._
