---
project_name: 'termul'
user_name: 'Althio'
date: '2026-05-09'
sections_completed: ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'quality_rules', 'workflow_rules', 'anti_patterns']
status: 'complete'
rule_count: 57
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

- **Desktop runtime:** Tauri 2 across JS and Rust (`@tauri-apps/api` `^2`, `@tauri-apps/cli` `^2`, Rust `tauri = "2.0"` with `unstable`)
- **Backend:** Rust `1.77+`, edition `2021`
- **Frontend:** React `18.3.1` + React DOM `18.3.1`
- **Language/tooling:** TypeScript `5.8.3` in strict mode, ESM-first repo (`"type": "module"`)
- **Build/test:** Vite `5.4.19`, Vitest `4.0.16` with `jsdom`
- **Linting:** ESLint `9.32.0` + `typescript-eslint` `8.38.0`
- **UI/state:** Tailwind CSS `3.4.17`, Zustand `5.0.9`, TanStack React Query `5.83.0`, Radix UI packages
- **Routing:** React Router DOM `6.30.1` using hash-router patterns
- **Terminal stack:** `tauri-pty ^0.1`, `@xterm/xterm ^5.5.0`, `@xterm/addon-*`
- **Forms/validation:** React Hook Form `7.61.1`, `@hookform/resolvers 3.10.0`, Zod `3.25.76`

### Critical stack constraints for AI agents

- Treat this repo as a **Tauri-first desktop app**, not a generic web SPA.
- Do **not** reintroduce Electron-era patterns; `docs/electron-old/` is archival migration context only.
- Keep native/runtime integration behind `src/renderer/lib/tauri-*.ts` and related facade modules where possible.
- `src/shared/` is for shared contracts/types only; keep it runtime-neutral.
- `src-tauri/` owns OS/process/backend behavior.
- Prefer `@renderer/*` and `@shared/*` imports in new code; alias behavior differs across TS, Vitest, and Vite configs.
- Do not assume one Vite config: both `vite.config.ts` and `vite.config.tauri.ts` are active and serve different purposes.
- Use scoped xterm packages (`@xterm/*`), not legacy `xterm` imports.
- Keep renderer code test-friendly for `Vitest + jsdom`; avoid scattering direct native imports through generic UI/state code.

## Critical Implementation Rules

### Language-Specific Rules

- Treat TypeScript as **strict-by-default**: `strict: true` and `noImplicitAny: true` are active. Do not add loose typings just to get code compiling.
- Prefer explicit types for public APIs, store state, function parameters, and return values when inference is not obvious.
- Keep shared contracts/types in `src/shared/` and renderer-only types/helpers in `src/renderer/`.
- Prefer existing aliases in imports, especially `@renderer/*` and `@shared/*`, instead of deep relative paths.
- Be careful with `@` imports: alias behavior differs between TypeScript, Vitest, generic Vite, and Tauri Vite configs.
- Follow the repo’s ESM-first setup (`"type": "module"`); do not introduce CommonJS-style config or import patterns unless a file already requires it.
- Keep browser-safe and native-aware code separated:
  - generic renderer code should depend on facades/contracts
  - Tauri/native access should stay in adapter-style modules or clearly Tauri-specific files
- Use async/await for asynchronous flows to match existing frontend patterns and keep control flow readable.
- Do not silence type/runtime issues with broad escape hatches like unnecessary `any`, unsafe casts, or catch-all suppression unless there is a documented reason.

### Framework-Specific Rules

- Treat the React app as a **desktop-oriented Tauri renderer**, not a generic browser-only SPA.
- Preserve the separation between:
  - UI/components/pages in `src/renderer/`
  - shared contracts in `src/shared/`
  - native/backend behavior in `src-tauri/`
- Prefer existing adapter/facade modules in `src/renderer/lib/` before adding new direct Tauri/plugin calls inside components.
- Keep direct native imports limited to clearly Tauri-scoped files when necessary; generic reusable UI should stay runtime-agnostic.
- Reuse existing Zustand store patterns in `src/renderer/stores/` before introducing new global state mechanisms.
- Use selector-style access patterns for Zustand when possible to match the existing store organization and reduce unnecessary rerenders.
- Treat TanStack React Query as an async/cache layer, not a replacement for Zustand app/session/UI state.
- Preserve hash-router-based navigation patterns; do not switch routing assumptions to browser-history routing.
- Follow existing component organization by domain and feature folder rather than creating a new top-level architecture style.
- Prefer existing Radix/shadcn-style UI composition and Tailwind utility patterns instead of introducing a second UI system.

### Testing Rules

- Place tests next to the code they cover using the repo’s colocated `*.test.ts` and `*.test.tsx` pattern.
- Write renderer tests to run under `Vitest + jsdom`; avoid assuming a real native Tauri runtime in normal component/unit tests.
- Prefer testing through public behavior and exported interfaces rather than internal implementation details.
- Keep native/runtime-dependent code behind adapter/facade boundaries so it can be mocked cleanly in tests.
- When adding Tauri-facing behavior, test the renderer-side contract and mocking boundary instead of coupling tests directly to native execution.
- Match existing test naming and file placement conventions already used across components, stores, and lib modules.
- Add regression tests for bug fixes, especially around terminal behavior, workspace/project state, and desktop integration boundaries.
- Keep test fixtures and mocks minimal and specific; avoid broad global mocking when a narrow seam already exists.
- Ensure new code remains compatible with the existing `typecheck` and `test` flow, including `tsconfig.web.json`-based type expectations.

### Code Quality & Style Rules

- Follow the existing TypeScript + ESLint setup; do not add patterns that fight the current lint configuration.
- Keep components, stores, hooks, and adapters focused on a single responsibility.
- Prefer small extensions to existing files/patterns over introducing parallel abstractions.
- Match existing naming patterns in the surrounding folder before adding new files or symbols.
- Keep tests colocated with implementation files using the established naming conventions.
- Reuse existing utility helpers and UI primitives before creating near-duplicate helpers/components.
- Use Tailwind and existing design tokens/CSS variables instead of hardcoding ad hoc visual values when project tokens already exist.
- Keep comments lean; add them when intent or a non-obvious constraint needs explanation, not to narrate obvious code.
- For public/shared APIs and important adapter seams, favor clear types and readable contracts over clever compactness.
- Keep changes compatible with the repo’s normal validation flow: lint, typecheck, and tests should remain green.

### Development Workflow Rules

- Follow the repo’s existing validation flow before considering a change complete: `npm run lint`, `npm run typecheck`, and `npm test`.
- Keep changes aligned with the current Tauri-first architecture and cleanup/parity-hardening direction of the repo.
- Use conventional commit message style when preparing commit-ready changes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Prefer incremental changes that fit existing structure over large unsolicited architectural rewrites.
- If touching cross-boundary behavior, preserve consistency between `src/renderer/`, `src/shared/`, and `src-tauri/`.
- Update or add tests for behavior changes and bug fixes before treating work as done.
- Update docs when a change alters user-facing behavior, setup requirements, or important architecture guidance.
- Do not treat archived migration docs as the source of truth for current implementation direction.
- Respect existing build entrypoints and config splits instead of collapsing them into a single assumed workflow.

### Critical Don't-Miss Rules

- Do **not** treat archived Electron migration material as active implementation guidance.
- Do **not** bypass `src/renderer/lib/` adapter boundaries by scattering direct native/plugin calls through generic components, hooks, or stores.
- Do **not** put renderer-specific UI logic or Tauri runtime behavior into `src/shared/`; keep it contract-focused and runtime-neutral.
- Do **not** assume alias behavior is identical across TypeScript, Vitest, and Vite configs.
- Do **not** treat the app as browser-history-first; preserve the existing hash-router navigation model.
- Do **not** introduce a second major state-management or UI framework when Zustand, Tailwind, Radix, and existing component patterns already cover the need.
- Do **not** “fix” strict typing by weakening types with broad `any`, unsafe casts, or blanket suppressions.
- Do **not** add code that is hard to test in `Vitest + jsdom` when an adapter seam can keep native concerns isolated.
- Watch for regressions in terminal/session/workspace behavior whenever touching cross-boundary desktop functionality.
- Prefer parity-preserving cleanup over speculative rewrites while the repo is still in cleanup/parity-hardening mode.

---

## Usage Guidelines

### Preflight Checklist

1. Read this file before implementing any code.
2. Confirm whether the change belongs in `src/renderer/`, `src/shared/`, or `src-tauri/`.
3. Respect the Tauri-first architecture; do not reintroduce Electron-era patterns.
4. Prefer `@renderer/*` and `@shared/*` imports; be careful with `@` alias differences across tools.
5. Keep native/plugin access behind `src/renderer/lib/tauri-*.ts` or related facade modules.
6. Follow strict TypeScript rules; avoid unnecessary `any` and unsafe casts.
7. Reuse existing Zustand, routing, Radix/shadcn, and Tailwind patterns.
8. Add or update colocated `*.test.ts` / `*.test.tsx` tests compatible with `Vitest + jsdom`.
9. Prefer extending existing patterns over introducing new frameworks or parallel abstractions.
10. Run `npm run lint`, `npm run typecheck`, and `npm test` before considering the change complete.

**For AI Agents:**

- Read this file before implementing any code.
- Follow all rules exactly as documented.
- When in doubt, prefer the more restrictive option.
- Update this file if new patterns emerge.

**For Humans:**

- Keep this file lean and focused on agent needs.
- Update when the technology stack changes.
- Review quarterly for outdated rules.
- Remove rules that become obvious over time.

Last Updated: 2026-05-09