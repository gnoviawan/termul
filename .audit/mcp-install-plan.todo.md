# Story 4: MCP install plan engine + consent (Feature playbook)

1. [ ] `how` over the affected subsystem. skip: worker under an Orchestrate brief with the subsystem already surveyed (spine AD-4/5/7/12, story 2 code read in full); design recorded below instead of a multi-model how run.
2. [ ] `architect` for parallel design exploration. skip: timebox (4h respawn) on security-critical work; one design chosen and written here, alternatives named in the report.
3. [x] Throughput checkpoint:
   - Blocking first steps: wire contract (mcp-catalog.types.ts) landed (6c8efc34); Rust digest first (pure, testable).
   - Independent workstreams: PR A (Rust + transports + facades) and PR B (renderer form + consent dialog, pushed 6d75b321) are both mine this round (one writer per worktree, no delegate).
   - Shared mutable state: none between A and B except the types file, which only A writes.
   - Smallest safe decomposition: finish A's engine, then transports, then B's verify + PR.
4. [ ] Delegate code-writing. skip: respawn brief says do the work myself in both worktrees.
5. [ ] Verify on the matching surface: cargo test mcp_catalog + web, clippy, typecheck, vitest.
   - r3: vitest (3 suites, 233 tests), typecheck, biome ci pass on PR A's TS side; PR B's 28 component tests pass.
   - r3: first lib-test compile found convert_tests.rs still building `CatalogItem { options }` (33112b3b renamed it to `parsed`); fixed.
   - r3: rustc died twice on commit-charge exhaustion while two other units linked (5 GB + 2 GB link.exe); rebuilt with CARGO_PROFILE_TEST_DEBUG=0 (full dep rebuild, no file changes).
   - r4: fingerprints show the 17:35 wave was the debug=0 build, so every cargo run exports CARGO_PROFILE_TEST_DEBUG=0 through the locked wrapper (-j 2; the lock serializes units).
   - r4: on the uncommitted tree, vitest 3 suites / 233 tests pass, `bun run typecheck` exit 0, `bun run ci` exit 0 (re-run, not trusted from r3).
   - r4: `git merge-tree HEAD origin/feat/mcp-catalog-core` (818df5cf) conflicts only in convert.rs and mcp-catalog.types.ts.
   - r4: first lib build (10m48s) compiled clean; exe exited 0xc0000139 (order 19). Touched and reran; the rerun sat >30 min behind another unit's lock and was killed by the background cap; restarted with the 2 h cap.
   - r4: build warned `ResolvedConfig::slots` never used; deleted it (clippy runs -D warnings).
   - r4: `.audit/` is not gitignored: commit with explicit paths only.
6. [ ] Small ordered commits (digest -> form -> import -> consent -> plan -> transports -> types/facades/parity).
   - done through consent (477e5911). Remaining: test fixes, plan engine, transports.
7. [ ] `interrogate` if contested. skip unless a design fork stays open.
8. [ ] Opening a PR (A against dev with "Depends on #1543", B against dev with "Merge after #A").

## Design (data shapes)
- PlanSource = catalog{name,version} | import{json,server?} | reapprove{entryId} | upgrade{entryId,version}   (tagged union, `kind`)
- PlanChoice = {kind: remote|package, index} (catalog only; default = row's default option)
- Slot (host-internal, form.rs) = {target: Env{name}|Header{name}|Argument{index, name?}|Url, source: Fixed(value, origin)|Input(field)|Template(text, vars), is_secret}
- Field (wire) = {id, label, target, variable, isRequired, isSecret, format, choices, default, placeholder, description}
- Described (engine) = {name, title, base: Stdio{command, args}|Remote{transport}, model: FormModel, provenance?, consent provenance?, deprecated, from_file}
- Assembled (engine) = {config: ResolvedConfig, shown: Vec<ShownValue>, secrets: Vec<ResolvedSecret>}; built by folding slots in order over the known values
- PlanStore = Mutex<HashMap<PlanId, StoredPlan{caller, created_at, consumed, described, values, digest}>> on McpCatalogService; TTL 10 min, cap 256 (oldest evicted), swept on access
- PlanCaller = Connection(ws connection id) | Client(HTTP body `clientInstanceId`)
- Digest = sha256 over fixed-field struct {v, transport, command, argv, url, env names sorted, header names sorted, provenance}
- Errors: VALIDATION_ERROR, MCP_CATALOG_NOT_FOUND, MCP_IMPORT_INVALID, MCP_PLAN_NOT_AVAILABLE, MCP_PLAN_NOT_FOUND, MCP_PLAN_CONSUMED, MCP_PLAN_EXPIRED, MCP_PLAN_MISMATCH, MCP_PLAN_WRONG_CALLER, FORBIDDEN (transport-native)
- Runner missing on the host => describe and plan both answer `unsupported { needs-runtime }` (a plan nothing can launch is not consentable)
- Commit: a secret-value VALIDATION_ERROR leaves the plan usable; MISMATCH, EXPIRED and success all consume it
- WS classes: describe = read; plan/commit/cancel = idempotent (not ledgered; follow-up: Command+ReceiptOnly once story 5 drives them through the command engine)

## Round 5 (2026-10-28, fresh respawn; core #1543 merged to dev as b69eec8e)
Order per briefs/s4-r5.md: (1) build + test the uncommitted tree on the current base, commit/push per green step (plan engine, transports, parity); (2) merge origin/feat/mcp-catalog-core 88a1455b, resolve convert.rs + mcp-catalog.types.ts, build/test/push; (3) merge origin/dev mechanically (unchanged-past-core files -> `git checkout origin/dev -- F`; changed files -> origin/dev's F + re-applied `git diff 88a1455b <pre-merge HEAD> -- F`), confirm `git diff origin/dev HEAD` is story 4 only and about 39 files; (4) clippy -D warnings, vitest, typecheck, bun run ci, open PR A; (5) merge A into B, typecheck + component tests, open PR B "Merge after #A".
- [ ] r5.1 lib tests on the uncommitted tree (`cargo-s4.cmd test --lib mcp_catalog -j 2`, CARGO_PROFILE_TEST_DEBUG=0)
- [ ] r5.2 commit plan engine, push
- [ ] r5.3 commit transports + facades + parity, push
- [ ] r5.4 merge core 88a1455b, adapt imports to check_package_spec, test, push
- [ ] r5.5 merge origin/dev mechanically, verify diff vs dev, test, push
- [ ] r5.6 clippy, vitest, typecheck, bun run ci
- [ ] r5.7 open PR A; merge A into B; verify B; open PR B
