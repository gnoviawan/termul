# AGENTS.md

## Project Documentation Entry Point

For repository context, architecture, and brownfield planning, start with:

- `docs/project-context.md` — required preflight context for implementation rules, boundaries, and anti-patterns
- `docs/index.md`

## Recommended Reading Order

Depending on the task, use these generated documents:

- `docs/architecture.md` — overall system architecture
- `docs/project-overview.md` — executive summary and stack overview
- `docs/source-tree-analysis.md` — directory structure and entry points
- `docs/component-inventory.md` — UI/workspace component map
- `docs/api-contracts.md` — internal Tauri IPC command/event contracts
- `docs/development-guide.md` — local setup, commands, and workflows
- `docs/deployment-guide.md` — release, signing, and updater pipeline
- `docs/contribution-guide.md` — contribution conventions

## Task Routing

- UI / renderer work: read `docs/architecture.md`, `docs/component-inventory.md`, and `docs/source-tree-analysis.md`
- Native / Tauri / Rust work: read `docs/architecture.md`, `docs/api-contracts.md`, and `docs/source-tree-analysis.md`
- Terminal behavior: read `docs/architecture.md` and `docs/api-contracts.md`
- Browser annotation behavior: read `docs/architecture.md`, `docs/component-inventory.md`, and `docs/api-contracts.md`
- Release / updater work: read `docs/deployment-guide.md` and `docs/auto-update-release-verification.md`

## Notes

- Read `docs/project-context.md` before implementation work.
- This project is a Tauri 2 desktop app with a React/TypeScript renderer and Rust runtime.
- Prefer the generated docs in `docs/` as the primary project knowledge base for AI-assisted work.
