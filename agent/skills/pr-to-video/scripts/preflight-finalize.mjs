#!/usr/bin/env node

// Phase 4c (pre-flight) — deterministic gate runner + brief writer.
//
// Sits between assemble-index.mjs / `verify-output.mjs sfx` and the finalize subagent.
// Owns the work that doesn't need LLM judgment:
//
//   1. Pin hyperframes CLI version (read from PROJECT_DIR/package.json) and
//      warm the npx cache with one `--yes hyperframes@<version> --version`
//      call. Subsequent CLI calls (here AND inside the agent) reuse this
//      pinned spec, so npx cache hits cleanly instead of cold-resolving on
//      every gate / snapshot / render. Eliminates the ~90s cache-miss /
//      "Missing module: contrast-audit" rabbit hole observed in prior runs.
//
//   2. Create `caption-overrides.json` empty-array shim if missing. The
//      captions runtime fetches this file at validate time; absence yields a
//      validate ✗ that previously cost finalize ~30s of chasing.
//
//   3. Run lint / validate / inspect once each with the pinned npx. Capture
//      stdout+stderr tails. Set `gates.{lint,validate,inspect}.ok` based on
//      exit code. Doesn't decide what to fix — that's still the agent's job
//      when something fails. But when all three pass, the agent skips Step 1
//      entirely (fast-path).
//
//   4. Compute snapshot timestamps from group_spec.json: per-scene midpoint
//      + high-risk extras (effect-driven heuristic mirroring the agent's old
//      rules). Hand to the agent verbatim so it doesn't recompute, dedupe,
//      or sort.
//
//   5. Run `captions.mjs keepout` (when captions are enabled) — static
//      scan of visual composition files for foreground `position: absolute`
//      elements with `bottom:` values inside the bottom-17% caption band.
//      Findings include Edit-ready old_string / new_string so the finalize
//      agent patches each scene in one Edit call per violation — no Read,
//      no search, no geometry math. Result lands in `caption_keepout`.
//      (The bbox math is transform- AND margin-aware; see captions.mjs.)
//
//   5b. Run `check-overlap.mjs` — the single-rule rendered overlap gate:
//      every scene is loaded standalone in headless Chrome, its timeline
//      seeked to 3 probe times, all non-background paint atoms flattened
//      onto one plane (z-index ignored) and pairwise-intersected. Persistent
//      foreground overlap = blocking violation (Repair Mode re-dispatch);
//      result lands in `overlap`. Chrome is reused from the hyperframes
//      browser cache; puppeteer-core resolves from the workspace node_modules
//      (`check-overlap.mjs --ensure-deps` installed it before scene fan-out).
//
//   6. Write everything to `finalize_brief.json` for the agent to consume in
//      one Read. Includes bgm_status.json (written by wait-bgm.mjs before
//      assemble) so the agent does not need to probe ps / ls / /tmp logs.
//      `preflight_clean = gates_clean && overlap clean && caption_keepout has
//      0 violations` — the agent uses this for fast-path decision.
//
// Exit codes:
//   0 — brief written. Clean OR with findings — either way the orchestrator
//       dispatches the finalize agent next, which fixes the brief's findings
//       in place (gates[].output_tail / overlap.violations[] /
//       caption_keepout.violations[]) before its lean visual pass + render.
//       Workers already self-ran the scoped gates at authoring time, so what
//       leaks here is small mechanical residue — finalize is the single
//       repair surface for it (worker re-dispatch is reserved for
//       recomposition-scale problems, via finalize STOP).
//   2 — the overlap gate could not run (`overlap.status: "unavailable"` —
//       puppeteer-core / Chrome missing). This is an ENVIRONMENT problem with
//       a deterministic remedy (`check-overlap.mjs --ensure-deps`, then
//       `npx hyperframes doctor` if Chrome is named); fix and re-run rather
//       than proceeding unmeasured.
//   1 — preflight itself crashed (bad arguments, group_spec missing, etc.)
//
// Usage:
//   node preflight-finalize.mjs --group-spec ./group_spec.json --hyperframes . \
//        [--out ./finalize_brief.json]

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------- argv ----------
const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
}

const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
const hyperframesDir = resolve(flag('hyperframes', '.'))
const outPath = resolve(flag('out', join(hyperframesDir, 'finalize_brief.json')))

if (!existsSync(groupSpecPath)) {
  console.error(`✗ preflight-finalize: group_spec.json missing at ${groupSpecPath}`)
  process.exit(1)
}
const groupSpec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))

// ---------- 1. Resolve pinned hyperframes version ----------
// Try in order:
//   (a) package.json `dependencies` / `devDependencies` (typical when the
//       project locally installs hyperframes)
//   (b) any `hyperframes@<version>` substring in package.json (what
//       `hyperframes init` actually writes today — version is baked into
//       `scripts.{dev,check,render,publish}` strings, not declared as a dep)
//   (c) `latest`
// Using `npx --yes hyperframes@<v>` keys npx cache on version, so all three
// gates + subsequent agent calls reuse the same resolution. The agent gets
// `npx_prefix` in the brief and uses it verbatim.
let pinnedVersion = 'latest'
const pkgPath = join(hyperframesDir, 'package.json')
if (existsSync(pkgPath)) {
  const raw = readFileSync(pkgPath, 'utf8')
  try {
    const pkg = JSON.parse(raw)
    const declared = pkg.dependencies?.hyperframes || pkg.devDependencies?.hyperframes || null
    if (declared && typeof declared === 'string') {
      pinnedVersion = declared.replace(/^[\^~>=<\s]+/, '').trim() || 'latest'
    }
  } catch {
    /* fall through to substring scan */
  }
  if (pinnedVersion === 'latest') {
    // Substring scan as fallback: matches `hyperframes@<version>` anywhere in
    // the file. Picks the first occurrence (typically `scripts.dev`).
    const m = raw.match(/hyperframes@([\d.][\d.\w\-+]*)/)
    if (m && m[1]) pinnedVersion = m[1]
  }
}
const npxPrefix = `npx --yes hyperframes@${pinnedVersion}`

// Warm cache + verify install in one shot. If this fails, the agent will see
// gates.lint.ok=false (its `lint` invocation will fail the same way) and can
// diagnose with full context — we don't try to fix it here.
let cliVersionLine = ''
try {
  cliVersionLine = execSync(`${npxPrefix} --version`, {
    cwd: hyperframesDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000
  }).trim()
} catch (e) {
  cliVersionLine = `(failed to resolve hyperframes@${pinnedVersion}: ${e.message?.split('\n')[0] || 'unknown'})`
}

// ---------- 2. caption-overrides.json shim ----------
// The captions runtime fetches caption-overrides.json at validate time; if
// it 404s, validate logs an error that previously made finalize chase a
// non-issue. An empty `[]` is a no-op override list, semantically identical
// to absent — but the file existing silences the validate noise.
const deterministicFixes = []
const captionOverridesPath = join(hyperframesDir, 'caption-overrides.json')
if (!existsSync(captionOverridesPath)) {
  writeFileSync(captionOverridesPath, '[]\n')
  deterministicFixes.push('caption-overrides.json: created empty [] shim')
}

// ---------- 3. Run gates ----------
// Each gate: capture tail of combined stdout+stderr (~60 lines is enough for
// the agent to spot the problem without overloading dispatch). The agent
// re-runs only the specific gate it needs deeper output from.
function runGate(name, args, { timeoutMs = 90_000 } = {}) {
  const t0 = Date.now()
  const res = spawnSync('npx', ['--yes', `hyperframes@${pinnedVersion}`, ...args], {
    cwd: hyperframesDir,
    encoding: 'utf8',
    timeout: timeoutMs
  })
  const dur = ((Date.now() - t0) / 1000).toFixed(2)
  const out = (res.stdout || '') + (res.stderr || '')
  const lines = out.split('\n')
  const tail = lines.slice(-60).join('\n')
  // hyperframes inspect (and lint when there's structured output) prints a
  // closing summary like "1 error(s), 11 warning(s), 2 info(s)". Parse it so
  // brief.gates.<gate>.{errors,warnings,info} surfaces without a second CLI
  // call. Absent / un-parseable → null fields; orchestrator falls back to
  // exit_code for the block decision.
  const summaryMatch = out.match(
    /(\d+)\s+error\(s\)(?:,\s+(\d+)\s+warning\(s\))?(?:,\s+(\d+)\s+info\(s\))?/i
  )
  const errors = summaryMatch ? Number(summaryMatch[1]) : null
  const warnings = summaryMatch && summaryMatch[2] != null ? Number(summaryMatch[2]) : null
  const info = summaryMatch && summaryMatch[3] != null ? Number(summaryMatch[3]) : null
  return {
    ok: res.status === 0,
    exit_code: res.status,
    duration_s: parseFloat(dur),
    errors,
    warnings,
    info,
    output_tail: tail
  }
}

// inspect's default --samples is 9. For a typical 30-60s product-launch video
// with 8-12 scenes, that's ~1 sample per scene, which routinely misses
// collisions that only become visible mid-phase animation (e.g. a CTA word
// that overflows the canvas only after its discrete-text-sequence reveal
// fires at local t≈1.9s of a 3.6s scene). 2 scenes × 3 phase-points each is a
// reasonable density / cost tradeoff; on a 40s 10-scene project this catches
// scene_10 CTA overflow that the 9-sample default missed.
const INSPECT_SAMPLES = Math.max(18, (groupSpec.total_scenes || 0) * 2)
// inspect runs STRICT — no --tolerance flag, CLI default (2px). By-design
// transient overflow (3D morph / tilt projection wobble, camera zoom peaks)
// is not tolerated numerically; it must be DECLARED on the element with
// data-layout-allow-overflow="true" (scene contract #9). Repair-worker scoped
// re-runs and finalize re-runs must also run plain `inspect` (no --tolerance)
// so verdicts agree with this gate.
const gates = {
  lint: runGate('lint', ['lint']),
  validate: runGate('validate', ['validate']),
  inspect: runGate('inspect', ['inspect', '--samples', String(INSPECT_SAMPLES)])
}
const gatesClean = gates.lint.ok && gates.validate.ok && gates.inspect.ok

// ---------- 4. Snapshot timestamps ----------
// Per-scene midpoint always. High-risk extras (* 0.75 and * 0.9) when the
// scene is long OR uses a multi-act effect OR the brief signals
// PrimarySubjectTimeline. Mirrors agent's old in-context rule so the agent
// gets the same coverage without recomputing.
const MULTI_ACT_EFFECTS = new Set([
  'multi-phase-camera',
  'coordinate-target-zoom',
  'camera-cursor-tracking',
  'viewport-change',
  '3d-page-scroll',
  'cursor-click-ripple',
  'reactive-displacement',
  'card-morph-anchor',
  'scale-swap-transition'
])
const HIGH_RISK_BRIEF_RX = /PrimarySubjectTimeline|multi-act|action-payoff|dense/i

const sceneRows = []
const tsSet = new Set()
function pushTs(t) {
  // Round to 3 decimals so HF CLI's --at parser doesn't reject and dedupe
  // across scene boundaries works.
  const rounded = Math.round(t * 1000) / 1000
  tsSet.add(rounded)
}

for (const group of groupSpec.groups || []) {
  for (const sid of group.scene_ids || []) {
    const s = group.scenes?.[sid]
    if (!s) continue
    const start = Number(s.start_s)
    const dur = Number(s.estimatedDuration_s)
    if (!isFinite(start) || !isFinite(dur) || dur <= 0) continue
    const midpoint = start + dur * 0.5
    pushTs(midpoint)
    const effects = Array.isArray(s.effects) ? s.effects : []
    const brief = String(s.creative_brief || '')
    const highRisk =
      dur >= 8 || effects.some((e) => MULTI_ACT_EFFECTS.has(e)) || HIGH_RISK_BRIEF_RX.test(brief)
    const extras = []
    if (highRisk) {
      const t075 = start + dur * 0.75
      const t090 = start + dur * 0.9
      pushTs(t075)
      pushTs(t090)
      extras.push(Math.round(t075 * 1000) / 1000, Math.round(t090 * 1000) / 1000)
    }
    sceneRows.push({
      scene_id: sid,
      start_s: start,
      duration_s: dur,
      midpoint_s: Math.round(midpoint * 1000) / 1000,
      high_risk_extras_s: extras,
      high_risk: highRisk,
      effects
    })
  }
}

// Transition seam midpoints — so finalize eyeballs the crossfade/push itself, not
// just scene mids (a 0.4-0.6s seam would otherwise fall between two scene-midpoint
// snapshots and never be captured). The transition plays in [to.start, to.start+dur]
// (extend-outgoing-only), so its visual midpoint is to.start + dur/2.
const sceneStart = new Map()
for (const group of groupSpec.groups || []) {
  for (const sid of group.scene_ids || []) {
    const s = group.scenes?.[sid]
    if (s && isFinite(Number(s.start_s))) sceneStart.set(sid, Number(s.start_s))
  }
}
const transitionRows = []
for (const t of groupSpec.transitions || []) {
  const toStart = sceneStart.get(t.to_scene || t.to)
  const dur = Number(t.duration_s)
  if (!isFinite(toStart) || !isFinite(dur) || dur <= 0) continue
  const seamMid = Math.round((toStart + dur * 0.5) * 1000) / 1000
  pushTs(seamMid)
  transitionRows.push({
    from: t.from,
    to: t.to,
    from_scene: t.from_scene || t.from,
    to_scene: t.to_scene || t.to,
    type: t.type,
    direction: t.direction || null,
    duration_s: dur,
    tier: t.tier,
    seam_mid_s: seamMid
  })
}

const internalSeamRows = []
for (const s of groupSpec.internal_seams || []) {
  const globalTime = Number(s.global_time_s)
  if (!isFinite(globalTime)) continue
  const rounded = Math.round(globalTime * 1000) / 1000
  pushTs(rounded)
  internalSeamRows.push({
    from_scene: s.from_scene,
    to_scene: s.to_scene,
    visual_id: s.visual_id,
    worker_id: s.worker_id,
    seam_s: rounded,
    local_time_s: s.local_time_s ?? null
  })
}

const snapshotTimes = [...tsSet].sort((a, b) => a - b)

// ---------- 5. Caption keep-out static check ----------
// Runs the deterministic keepout gate (formerly check-caption-keepout.mjs, now
// `captions.mjs keepout`) as a subprocess and parses its --json result — same
// pure check, just out-of-process so this file doesn't import captions.mjs's
// CLI dispatcher. Skipped automatically when group_spec.captions_enabled !==
// true. Findings include Edit-ready old_string / new_string strings so the
// finalize agent can patch each violation with one Edit call per scene file.
// No Read, no search, no math — the brief encodes the full transform.
let captionKeepout = {
  enabled: groupSpec?.captions_enabled === true,
  scenes_scanned: 0,
  violations: []
}
try {
  const captionsScript = join(__dirname, 'captions.mjs')
  const res = spawnSync(
    process.execPath,
    [
      captionsScript,
      'keepout',
      '--json',
      '--group-spec',
      groupSpecPath,
      '--hyperframes',
      hyperframesDir
    ],
    { encoding: 'utf8', timeout: 60000 }
  )
  if (res.stdout && res.stdout.trim()) captionKeepout = JSON.parse(res.stdout)
} catch {
  // keep the safe default; preflight always exits 0
}
const keepoutClean = captionKeepout.violations.length === 0

// ---------- 5b. Rendered overlap gate ----------
// Single-rule browser gate: z-flatten all non-background paint atoms per
// scene, no two may intersect (see check-overlap.mjs header). Spawned
// out-of-process like keepout. `status: "unavailable"` (no puppeteer module /
// no Chrome) is NOT a soft skip — it blocks like a violation, with the remedy
// in `reason`, because an unmeasured layout must not read as a clean one.
let overlap = {
  status: 'unavailable',
  reason: 'check-overlap.mjs did not produce output',
  violations: [],
  transients: [],
  scenes_scanned: 0
}
try {
  const overlapScript = join(__dirname, 'check-overlap.mjs')
  const res = spawnSync(
    process.execPath,
    [overlapScript, '--json', '--group-spec', groupSpecPath, '--hyperframes', hyperframesDir],
    { encoding: 'utf8', timeout: 300_000 }
  )
  if (res.stdout && res.stdout.trim()) overlap = JSON.parse(res.stdout)
  else if (res.stderr && res.stderr.trim())
    overlap.reason = res.stderr.trim().split('\n').slice(0, 3).join(' / ')
} catch (e) {
  overlap.reason = e.message?.split('\n')[0] || 'spawn failed'
}
const overlapClean = overlap.status === 'ok' && overlap.violations.length === 0

const preflightClean = gatesClean && overlapClean && keepoutClean

// ---------- 5b. BGM status ----------
// wait-bgm.mjs runs before assemble-index.mjs. Surface its verdict here so the
// finalize agent never has to do ad hoc `ls assets/bgm.wav`, `ps`, or
// BGM-log checks.
function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const bgmStatusPath = join(hyperframesDir, 'bgm_status.json')
const bgmStatus = readJson(bgmStatusPath)
const bgmPath = groupSpec.bgm_path || ''
const bgmReady = Boolean(bgmPath && existsSync(join(hyperframesDir, bgmPath)))
const bgm = {
  enabled: Boolean(bgmPath),
  path: bgmPath || null,
  ready: bgmReady,
  status_file: existsSync(bgmStatusPath) ? 'bgm_status.json' : null,
  status: bgmStatus?.status || (bgmReady ? 'ready' : bgmPath ? 'missing' : 'disabled'),
  provider: bgmStatus?.provider || null,
  mode: bgmStatus?.mode || null,
  log: bgmStatus?.log || null,
  pid: bgmStatus?.pid || null,
  target_duration_s: bgmStatus?.target_duration_s || null,
  seed_duration_s: bgmStatus?.seed_duration_s || null,
  loop_count: bgmStatus?.loop_count || null,
  message:
    bgmStatus?.message ||
    (bgmReady
      ? `BGM ready at ${bgmPath}.`
      : bgmPath
        ? 'BGM path declared but file missing.'
        : 'No BGM path.')
}

// ---------- 5.6. Anomalies (loud, brief-level) ----------
// Things the orchestrator / finalize agent should NOTICE even when they don't
// block preflight. Currently empty in the normal path; phases can grow this
// list over time (keep the field so brief consumers have a stable shape).
const anomalies = []

// ---------- 6. Write brief ----------
const brief = {
  version: 3,
  generated_at: new Date().toISOString(),
  pinned_hyperframes_version: pinnedVersion,
  cli_version_line: cliVersionLine,
  npx_prefix: npxPrefix,
  gates_clean: gatesClean,
  gates,
  bgm,
  overlap,
  caption_keepout: captionKeepout,
  anomalies,
  preflight_clean: preflightClean,
  deterministic_fixes_applied: deterministicFixes,
  snapshot_times_s: snapshotTimes,
  total_duration_s: groupSpec.total_duration_s,
  scenes: sceneRows,
  transitions: transitionRows,
  internal_seams: internalSeamRows
}

writeFileSync(outPath, JSON.stringify(brief, null, 2) + '\n')

// ---------- stdout summary ----------
console.log(`✓ wrote ${outPath}`)
console.log(`  hyperframes:    ${pinnedVersion} (${cliVersionLine || 'version unknown'})`)
console.log(
  `  preflight_clean: ${preflightClean ? 'yes (gates + overlap + caption keep-out)' : 'no'}`
)
console.log(
  `    lint:     ${gates.lint.ok ? '✓' : '✗'} (${gates.lint.duration_s}s, exit ${gates.lint.exit_code})`
)
console.log(
  `    validate: ${gates.validate.ok ? '✓' : '✗'} (${gates.validate.duration_s}s, exit ${gates.validate.exit_code})`
)
console.log(
  `    inspect:  ${gates.inspect.ok ? '✓' : '✗'} (${gates.inspect.duration_s}s, exit ${gates.inspect.exit_code}, strict — no tolerance)`
)
if (overlap.status !== 'ok') {
  console.log(`    overlap:  ✗ gate unavailable — ${overlap.reason}`)
} else if (overlapClean) {
  console.log(
    `    overlap:  ✓ (${overlap.scenes_scanned} scene(s) probed, 0 violations${overlap.transients?.length ? `, ${overlap.transients.length} transient crossing(s) noted` : ''}${overlap.scenes_no_timeline ? `, ⚠ ${overlap.scenes_no_timeline} scene(s) probed at t=0 only` : ''})`
  )
} else {
  console.log(
    `    overlap:  ✗ (${overlap.violations.length} foreground overlap(s) across ${new Set(overlap.violations.map((v) => v.scene_id)).size} scene(s))`
  )
  for (const v of overlap.violations) {
    console.log(
      `      [${v.scene_id}] ${v.a.selector} × ${v.b.selector}: ${v.overlap.width}×${v.overlap.height}px at (${v.overlap.left},${v.overlap.top}), t=${v.probe_times_s.join('/')}s`
    )
  }
}
if (!captionKeepout.enabled) {
  console.log(`    caption-keepout: skipped (captions_enabled=false)`)
} else if (keepoutClean) {
  console.log(
    `    caption-keepout: ✓ (${captionKeepout.scenes_scanned} scene(s) scanned, 0 violations)`
  )
} else {
  console.log(
    `    caption-keepout: ✗ (${captionKeepout.violations.length} violation(s) across ${new Set(captionKeepout.violations.map((v) => v.scene_id)).size} scene(s)) — see brief.caption_keepout.violations[] for Edit-ready strings`
  )
  for (const v of captionKeepout.violations) {
    console.log(
      `      [${v.scene_id}] ${v.selector} (${v.pattern}): element bottom at y=${v.element_bottom_y} → Edit \`${v.edit_old}\` → \`${v.edit_new}\``
    )
  }
}
console.log(
  `  snapshot_times: ${snapshotTimes.length} timestamp(s)${transitionRows.length ? ` (incl. ${transitionRows.length} transition seam mid${transitionRows.length > 1 ? 's' : ''})` : ''}`
)
console.log(
  `  deterministic_fixes: ${deterministicFixes.length === 0 ? 'none' : deterministicFixes.join('; ')}`
)
if (!preflightClean) {
  if (!gatesClean) {
    console.log(
      `\n  ⚠ at least one CLI gate failed — finalize agent will diagnose from brief.gates[].output_tail`
    )
  }
  if (!overlapClean) {
    console.log(
      `  ⚠ foreground overlap — route brief.overlap.violations[] verbatim to Repair Mode worker re-dispatch (geometry included; workers self-verify with check-overlap --scene)`
    )
  }
  if (!keepoutClean) {
    console.log(
      `  ⚠ caption-keepout violations — finalize agent applies brief.caption_keepout.violations[].edit_old → edit_new in each file (one Edit per violation, no Read needed)`
    )
  }
}

// ---------- 7. Exit ----------
// Findings do NOT block: the brief carries them and the finalize agent fixes
// them in place as its first work step (workers already self-ran the scoped
// gates, so residue here is small and mechanical; bouncing it back through a
// worker re-dispatch round costs more than finalize's direct Edit). The ONLY
// hard stop is an unmeasured overlap gate — an environment problem with a
// deterministic remedy, not a finding.
if (overlap.status === 'unavailable') {
  console.error(`\n✗ BLOCKED: overlap gate could not run (${overlap.reason}).`)
  console.error(`  brief: ${outPath}`)
  console.error(
    `  → run \`node check-overlap.mjs --ensure-deps\` from the workspace root (and \`npx hyperframes doctor\` if it names Chrome), then re-run this script — do not proceed unmeasured.`
  )
  process.exit(2)
}
if (!preflightClean) {
  console.error(
    `\n⚠ findings present (gates/overlap/keepout above) — dispatch finalize; it fixes them in place from the brief before the lean visual pass + render.`
  )
}
