# AGENTS.md

<!-- bmad:context -->
<!-- Verified 2026-10-03 against 1882471d. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Termul main app

Termul is a Tauri 2 desktop application with a React/TypeScript renderer and Rust runtime. The same Rust crate supports desktop shared-live remote access, the standalone `termul-server`, and a responsive browser client. These instructions cover the main application and exclude `landing/`. Deeper documentation is indexed at `docs/index.md`; `docs/project-context.md` is retained as legacy reference material, not as an instruction source.

## Policy

- Target PRs to `dev`. Before opening one, search open and closed PRs for duplicates, follow `.github/PULL_REQUEST_TEMPLATE.md`, submit one real problem per PR, and obtain human approval of the complete diff.
- Do not force-push merely to retrigger CI or ask maintainers to bypass failed checks; fix failures and address or technically rebut review findings.
- Keep PRs to 50 changed files or fewer; CodeRabbit's free tier stops reviewing past 100, and smaller diffs get better reviews anyway. Split larger work into stacked PRs.
- Add durable boundary and failure logs for every new feature or flow using `log` for desktop Rust, `tracing` for `termul-server`, or `src/renderer/lib/log-api.ts` for renderer code; never log secrets or credentials.

## Where things are

- Renderer and browser UI: `src/renderer/`; runtime-neutral contracts: `src/shared/`; desktop runtime and shared web/server implementation: `src-tauri/`.
- Cross-surface adapter coverage: `src/renderer/lib/__tests__/parity-checklist.test.ts`; web routes: `src-tauri/src/web/`; standalone composition: `src-tauri/src/server_main.rs`; desktop shared-live host: `src-tauri/src/remote/host.rs`.
- Splitting/slimming conventions and current refactor status: `docs/contribution-guide.md` (Size and splitting rules section).

## Conventions that differ from defaults

- Keep `src/shared/` limited to runtime-neutral contracts; renderer behavior belongs in `src/renderer/`, and native/backend behavior belongs in `src-tauri/`.
- Before implementing a feature or behavioral change, evaluate the Tauri desktop, desktop shared-live remote, standalone `termul-server`, and browser/phone UI. Implement every applicable surface together rather than deferring parity to later manual checks.
- Put host-backed behavior in shared Rust services and expose equivalent Tauri and web transports through renderer facades. Add parity tests for both paths; if a capability is intentionally platform-only, gate it explicitly with `isTauriContext()` and test the unsupported state instead of relying on a throwing Tauri stub.
- Keep both renderer roots consistent when adding routes, providers, hooks, or user-visible behavior: `src/renderer/TauriApp.tsx` and `src/renderer/App.tsx`.
- Keep files under ~800 prod code lines. When one crosses that, split it: Rust single-file modules become `<name>/` dirs (`web/ws/` pattern — handlers by domain, `pub use` re-exports keep `crate::` paths), TS stores become domain slices (`acp-store/` pattern), large components become leaf components + hooks (`GitPanel`/`AppPreferences` pattern). Move code, never rewrite behavior.
- Put Rust unit tests in a sibling `<name>_tests.rs` or `<name>/tests.rs` — never an inline `#[cfg(test)] mod tests` tail inside the production file. Place new test mods as siblings of the module they test.
- Shared renderer IPC/test helpers are canonical: `lib/ipc/{tauri,http}.ts` for `invokeIpc`/`serverBase`, `lib/test-utils/` for `mockTerminal` and store factories. Do not re-define these locally in adapters or test files.
- After any component/module split, grep the extracted symbols for orphaned imports before committing — splits orphan their own consumers (observed twice: `useTerminals`, `CommandChip` went dead when #812 removed their importers).

## Known pitfalls

- Preserve live PTY sessions across project switches; do not kill or recreate them as navigation cleanup.

<!-- /bmad:context -->

## Design system

Renderer UI rules: `DESIGN.md` (entry) and `docs/design/` (topics). Use semantic tokens and listed variants only. Never Tailwind palette primitives (`bg-red-500`, `text-white`, `bg-black/50`). `Button` has no `primary` variant (`default` is the fill). `ConfirmDialog` uses `danger`, not `destructive`.
