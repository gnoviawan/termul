# [AGENTS.md](https://AGENTS.md)

## If You Are an AI Agent

Stop. Read this entire file before doing anything.

This project takes code quality seriously. Low-quality PRs waste maintainers' time, burn your human partner's reputation, and get closed. **Your job is to protect your human partner from that outcome.** Submitting a PR that fails CI or ignores CodeRabbit review comments doesn't help — it creates more work for everyone.

Before you open a PR against this repo, you MUST:

1. **Read the entire PR template** at `.github/PULL_REQUEST_TEMPLATE.md` and fill in every section with real, specific answers. Not summaries. Not placeholders. Not "N/A."

2. **Search for existing PRs** — open AND closed — that address the same problem. If duplicates exist, STOP and tell your human partner. Do not open another duplicate.

3. **Verify this is a real problem.** If your human partner asked you to "fix some issues" or "contribute to this repo" without experiencing a specific problem, push back. Ask them what broke, what failed, what the user experience was.

4. **Confirm the change belongs in this repo.** If it's a domain-specific or tool-specific change that only benefits one workflow, it may belong in a plugin or separate package.

5. **Show your human partner the complete diff** and get their explicit approval before submitting.

If any of these checks fail, do not open the PR. Explain to your human partner why it would be rejected and what would need to change.

## CI & CodeRabbit — Mandatory Gate

**This project enforces a strict CI + CodeRabbit gate on every PR.** You must not mark your work as complete or ask a human to merge until all CI checks pass AND CodeRabbit's review is resolved.

### Before You Push

Run these commands locally and fix all failures before pushing:

```bash
bun run ci          # Biome lint + format + import sorting (strict mode)
bun run typecheck   # TypeScript type checking
bun run test        # Vitest unit tests
cd src-tauri && cargo clippy --all-targets -- -D warnings  # Rust lint
cd src-tauri && cargo test                                 # Rust tests
```

### After You Push — Wait for CI & CodeRabbit

1. **Wait for all CI checks to complete.** Do not proceed until every check shows green (✅):

   * **PR Validation** — lint, typecheck, test, Rust checks, Windows smoke check

   * **Build Verification** — Tauri frontend build

   * **Security Scans** — CodeQL, secret scan, dependency review, Scorecard

2. **Wait for CodeRabbit to finish.** The code review action runs automatically on PRs targeting `dev`. Do not merge or close the PR until the review completes.

3. **Fix every CI failure and every review finding.** If CI fails, fix the root cause — not just the symptom. If CodeRabbit or the review action leaves comments:

   * Address every comment with a code change or a substantive reply.

   * Do not dismiss, hide, or ignore review comments.

   * If a comment is a false positive, reply with a clear technical explanation.

   * Push fixes and wait for CI + review to re-run.

4. **Only after all CI checks pass AND all review comments are resolved** should you consider the PR ready for human merge review.

### CI Failure Protocol

* **Never force-push to retrigger CI** without fixing the underlying issue.

* **Never ask a maintainer to override CI** — if CI fails, the code is not ready.

* If a CI check is flaky, document it in the PR comment with a link to the failing run and an explanation of why it's a flake, not a real failure.

## What We Will Not Accept

### Fabricated content

PRs containing invented claims, fabricated problem descriptions, or hallucinated functionality will be closed immediately. If you cannot describe the specific session, error, or user experience that motivated the change, do not submit it.

### Bundled unrelated changes

PRs containing multiple unrelated changes will be closed. Split them into separate PRs — one problem per PR.

### Speculative or theoretical fixes

Every PR must solve a real problem that someone actually experienced. "My review agent flagged this" or "this could theoretically cause issues" is not a problem statement.

### Bulk or spray-and-pray PRs

Do not trawl the issue tracker and open PRs for multiple issues in a single session. Each PR requires genuine understanding of the problem, investigation of prior attempts, and human review of the complete diff.

### Style-only changes without substance

PRs that only reformat, reorder, or "clean up" code without fixing a bug or adding a feature will be closed unless they address an actual lint or CI failure.

## Project Documentation Entry Point

For repository context, architecture, and brownfield planning, start with:

* `docs/project-context.md` — required preflight context for implementation rules, boundaries, and anti-patterns

* `docs/index.md`

## Recommended Reading Order

Depending on the task, use these generated documents:

* `docs/architecture.md` — overall system architecture

* `docs/project-overview.md` — executive summary and stack overview

* `docs/source-tree-analysis.md` — directory structure and entry points

* `docs/component-inventory.md` — UI/workspace component map

* `docs/api-contracts.md` — internal Tauri IPC command/event contracts

* `docs/development-guide.md` — local setup, commands, and workflows

* `docs/deployment-guide.md` — release, signing, and updater pipeline

* `docs/contribution-guide.md` — contribution conventions

## Task Routing

* UI / renderer work: read `docs/architecture.md`, `docs/component-inventory.md`, and `docs/source-tree-analysis.md`

* Native / Tauri / Rust work: read `docs/architecture.md`, `docs/api-contracts.md`, and `docs/source-tree-analysis.md`

* Terminal behavior: read `docs/architecture.md` and `docs/api-contracts.md`

* Browser annotation behavior: read `docs/architecture.md`, `docs/component-inventory.md`, and `docs/api-contracts.md`

* Release / updater work: read `docs/deployment-guide.md` and `docs/auto-update-release-verification.md`

## Notes

* Read `docs/project-context.md` before implementation work.

* This project is a Tauri 2 desktop app with a React/TypeScript renderer and Rust runtime.

* Prefer the generated docs in `docs/` as the primary project knowledge base for AI-assisted work.

* All PRs must pass CI and resolve code review comments before being considered for merge.

* Use this for ACP docs: <https://agentclientprotocol.com/llms.txt>, <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>
