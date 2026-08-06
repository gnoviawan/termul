## Summary

Establishes the host as the authority for portable ACP history, terminal claim leases, versioned workspace manifests, and project selection. The host now owns durable transcripts, terminal claim credentials, versioned workspace manifests, and per-client/host project selection; renderers are projections that never use localStorage as the cross-client authority. This is the first half of the cross-client continuity epic (CAP-1 through CAP-5 and CAP-7); CAP-6 (host ACP catalog + verified atomic installation) follows in a separate PR.

## Related Issue

No related issue — this is a self-contained epic derived from the verified parity research.

## Type of Change

- [x] feat: new feature
- [x] test: adds or updates tests

## What Changed

- CAP-1: Standalone ACP session payload recovery — host-persisted transcript + cursor-correct live continuation
- CAP-2: Host-owned shared-live ACP history — browser-origin sessions become durable without a desktop renderer (renderer saveSessionPayload retired to no-op)
- CAP-4: Authoritative agent spawn metadata — capabilities + auth methods delivered before session-creation decisions
- CAP-3: Reclaimable terminal leases — host-issued unguessable claim credentials + project authorization + rotation/revocation (SHA-256 digest stored, not raw credential)
- CAP-5: Versioned workspace manifest service + cross-client restore with revision-conflict detection (atomic write + corrupt-backup, ETag/conflict response)
- CAP-7: Separate client-local and host-default project selection — one client switch cannot retarget all connected clients

Also fixes three production bugs caught by CI-Linux (tests never ran locally on Windows due to pre-existing DLL issue):
- PTY claims digest mismatch (issue hashed raw bytes, verify hashed hex string)
- WriteOutcome serde field naming (rename_all=lowercase only renames variant names, not fields)
- Nested tokio runtime in test (block_on inside tokio::test panics on Linux)

## How It Was Tested

- [x] `bun run ci` (Biome lint + format + imports, strict mode)
- [x] `bun run typecheck`
- [x] `bun run test` — 3258 passed, 43 skipped, 0 failed
- [x] `cargo clippy --all-targets --features standalone-server -- -D warnings` (in src-tauri)
- [ ] `cargo test` (in src-tauri) — compile-verified locally; runs on CI-Linux (pre-existing Windows DLL issue)
- [ ] Manual verification completed

## CI and Review Gate

- [ ] All CI checks pass (PR Validation, Rust Checks, Build Verification, Security Scans)
- [ ] Code review comments from CodeRabbit / Claude have been addressed or resolved
- [ ] No unresolved review findings remain

## Checklist

- [x] My PR title follows the conventional commit format used by this repo
- [x] I linked the related issue or explained why none exists
- [x] I updated docs when needed
- [x] I added or updated tests when needed
- [x] I verified the change does not introduce unrelated modifications
- [x] I read AGENTS.md and followed the contributor guidelines
- [ ] A human reviewed the complete diff before submission
