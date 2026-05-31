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
