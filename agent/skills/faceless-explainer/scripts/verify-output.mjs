#!/usr/bin/env node

// verify-output.mjs — merged post-render verification dispatcher.
//
// Merges two former standalone scripts into one subcommand-dispatched file:
//   render → verify-render.mjs  (deterministic post-render mp4 verification)
//   sfx    → sfx-verify.mjs      (SFX drift verifier against emitted index.html)
//
// Original usage lines (now subcommands):
//   node verify-output.mjs render --hyperframes . --group-spec ./group_spec.json [--output renders/video.mp4]
//   node verify-output.mjs sfx --group-spec ./group_spec.json --index ./index.html

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// render — (was verify-render.mjs)
// Phase 4c (engine) — deterministic post-render mp4 verification. No subagent.
//
// The old finalize "Step 6" three-check, lifted out of the agent: a render
// either produced a plausible mp4 or it didn't, and that's a pure function of
// the file + ffprobe + group_spec.total_duration_s. The finalize/visual-QA
// agent no longer hand-runs stat/ffprobe or eyeballs the duration delta.
//
// Reads:  ./group_spec.json (total_duration_s) + the rendered mp4 on disk.
// Checks: 1. file exists
//         2. size >= MIN_BYTES (a 0-frame / header-only mp4 is a failed render)
//         3. ffprobe container duration within DUR_TOLERANCE_S of
//            group_spec.total_duration_s
//
// Usage:
//   node verify-output.mjs render --hyperframes . --group-spec ./group_spec.json \
//        [--output renders/video.mp4]
//
// Exit 0 = all three pass (summary on stdout).
// Exit 1 = any check fails (stderr names which + the numbers).
// ---------------------------------------------------------------------------
async function runRender(argv) {
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
  }
  function die(msg) {
    console.error(`✗ verify-render.mjs: ${msg}`)
    process.exit(1)
  }

  const MIN_BYTES = 10 * 1024 // 10 KB — below this is a header-only / 0-frame render
  // Deliberately generous container-duration tolerance: 0.5s is many frames at any
  // supported fps (15 frames @ 30fps), so normal encoder frame-quantization + MP4
  // timestamp rounding never trips it. It is NOT a precision check — the drift it
  // actually catches is structural (a scene clip with the wrong data-duration, or a
  // sub-comp static-frame fallback running full length; see the failure message below).
  // There is no shared renderer constant to import, so this is the single point to
  // sync: if the engine ever changes how it pads/trims trailing frames, widen here.
  const DUR_TOLERANCE_S = 0.5

  const hyperframesDir = resolve(flag('hyperframes', '.'))
  const groupSpecPath = resolve(flag('group-spec', join(hyperframesDir, 'group_spec.json')))
  const outputArg = flag('output', 'renders/video.mp4')
  const outputPath = resolve(hyperframesDir, outputArg)

  if (!existsSync(groupSpecPath)) die(`group_spec.json not found at ${groupSpecPath}`)
  let expectedDuration
  try {
    expectedDuration = Number(JSON.parse(readFileSync(groupSpecPath, 'utf8')).total_duration_s)
  } catch (e) {
    die(`group_spec.json parse: ${e.message}`)
  }
  if (!isFinite(expectedDuration) || expectedDuration <= 0)
    die(`group_spec.total_duration_s missing or non-positive`)

  // Check 1: exists
  if (!existsSync(outputPath)) die(`no render at ${outputPath} — render did not produce output`)

  // Check 2: size
  const size = statSync(outputPath).size
  if (size < MIN_BYTES)
    die(
      `render is only ${size}B (< ${MIN_BYTES}B) — header-only / 0-frame render; check render stderr`
    )

  // Check 3: ffprobe duration within tolerance
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outputPath],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) {
    die(
      `ffprobe failed on ${outputPath} (exit ${r.status}) — file may be corrupt: ${(r.stderr || '').trim().slice(0, 200)}`
    )
  }
  const actualDuration = parseFloat((r.stdout || '').trim())
  if (!isFinite(actualDuration)) die(`ffprobe returned no parseable duration for ${outputPath}`)
  const drift = Math.abs(actualDuration - expectedDuration)
  if (drift > DUR_TOLERANCE_S) {
    die(
      `render duration ${actualDuration.toFixed(3)}s drifts ${drift.toFixed(3)}s from group_spec ${expectedDuration}s (> ${DUR_TOLERANCE_S}s) — a scene clip likely has the wrong data-duration, or a sub-comp failed to mount (static-frame fallback runs full length)`
    )
  }

  const mb = (size / (1024 * 1024)).toFixed(2)
  console.log(`✓ verify-render: ${outputArg}`)
  console.log(`  size:     ${mb} MB (${size}B)`)
  console.log(
    `  duration: ${actualDuration.toFixed(3)}s vs expected ${expectedDuration}s (drift ${drift.toFixed(3)}s ≤ ${DUR_TOLERANCE_S}s)`
  )
}

// ---------------------------------------------------------------------------
// sfx — (was sfx-verify.mjs)
// SFX drift verifier — runs after finalize emits index.html.
//
// Reads:  group_spec.json (the truth: sfx[] = flat list with global t,
//         duration from manifest, file from manifest) + index.html (what
//         finalize actually emitted).
// Checks: for every cue in group_spec.sfx[]
//   1. matching <audio src="assets/sfx/<file>" data-start data-duration ...> exists
//   2. data-start drifts ≤ 0.1s from group_spec.t
//   3. data-duration === group_spec.duration (manifest truth; not truncated)
// Also flags <audio src="assets/sfx/..."> in index.html that are NOT in
// group_spec.sfx[] (finalize improvised an SFX → contract violation).
//
// Exit 0 = all pass. Exit 1 = any failure. stderr lists each failure with
// file, expected vs actual t / duration, and one-line guidance.
//
// Usage:
//   node verify-output.mjs sfx --group-spec ./group_spec.json --index ./index.html
// ---------------------------------------------------------------------------
async function runSfx(argv) {
  const DRIFT_TOLERANCE_S = 0.1 // 3 frames @ 30fps; same as v1 w2h-verify

  function flag(name) {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
  }
  function die(msg) {
    console.error(`✗ sfx-verify: ${msg}`)
    process.exit(1)
  }

  const groupSpecPath = resolve(flag('group-spec') || './group_spec.json')
  const indexPath = resolve(flag('index') || './index.html')

  if (!existsSync(groupSpecPath)) die(`group_spec.json missing at ${groupSpecPath}`)
  if (!existsSync(indexPath)) die(`index.html missing at ${indexPath}`)

  const groupSpec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
  const indexHtml = readFileSync(indexPath, 'utf8')

  const expected = Array.isArray(groupSpec.sfx) ? groupSpec.sfx : []

  if (expected.length === 0) {
    console.log('✓ sfx-verify: 0 SFX cues in group_spec — nothing to check')
    process.exit(0)
  }

  // ---------- Extract all <audio src="assets/sfx/X"> tags from index.html ----------
  // Use a two-step extraction (tag → attributes) so attribute order doesn't matter.
  const audioTags = []
  const audioTagRe = /<audio\b[^>]*>/g
  let m
  while ((m = audioTagRe.exec(indexHtml)) !== null) {
    const tag = m[0]
    const srcMatch = tag.match(/\bsrc=["'](?:\.?\/)?(?:assets\/)?sfx\/([\w.-]+\.mp3)["']/)
    if (!srcMatch) continue
    const tMatch = tag.match(/\bdata-start=["']([0-9.]+)["']/)
    const dMatch = tag.match(/\bdata-duration=["']([0-9.]+)["']/)
    audioTags.push({
      file: srcMatch[1],
      t: tMatch ? parseFloat(tMatch[1]) : null,
      duration: dMatch ? parseFloat(dMatch[1]) : null,
      raw: tag
    })
  }

  // ---------- Verify each expected cue against emitted tags ----------
  const failures = []
  const matchedTagIdx = new Set()

  for (const cue of expected) {
    // Find the closest unmatched tag with the same file. Allows multi-instances
    // of the same SFX file at different times (e.g. multiple `pop.mp3` cues).
    let bestIdx = -1
    let bestDrift = Infinity
    for (let i = 0; i < audioTags.length; i++) {
      if (matchedTagIdx.has(i)) continue
      if (audioTags[i].file !== cue.file) continue
      if (audioTags[i].t == null) continue
      const drift = Math.abs(audioTags[i].t - cue.t)
      if (drift < bestDrift) {
        bestDrift = drift
        bestIdx = i
      }
    }
    if (bestIdx < 0) {
      failures.push(
        `MISSING: ${cue.file} expected at t=${cue.t}s (scene ${cue.scene_id}, note "${cue.note}") — no matching <audio> in index.html`
      )
      continue
    }
    matchedTagIdx.add(bestIdx)
    const tag = audioTags[bestIdx]
    if (bestDrift > DRIFT_TOLERANCE_S) {
      failures.push(
        `DRIFT: ${cue.file} expected t=${cue.t}s, found t=${tag.t}s (drift ${bestDrift.toFixed(3)}s > ${DRIFT_TOLERANCE_S}s) — agent eyeballed instead of computing`
      )
    }
    if (tag.duration != null && Math.abs(tag.duration - cue.duration) > 0.001) {
      failures.push(
        `DURATION: ${cue.file} expected data-duration=${cue.duration}s (from manifest), found ${tag.duration}s — never truncate; decay tail belongs in the next clip`
      )
    }
  }

  // Flag extra <audio src="sfx/..."> not in group_spec (finalize improvised).
  for (let i = 0; i < audioTags.length; i++) {
    if (matchedTagIdx.has(i)) continue
    const t = audioTags[i]
    failures.push(
      `UNEXPECTED: index.html emits assets/sfx/${t.file} at t=${t.t}s but no matching cue in group_spec.sfx — finalize must not invent SFX (translator-only role)`
    )
  }

  if (failures.length === 0) {
    console.log(
      `✓ sfx-verify: ${expected.length} cue(s), all matched within ±${DRIFT_TOLERANCE_S}s drift`
    )
    process.exit(0)
  }

  console.error(`✗ sfx-verify: ${failures.length} failure(s)`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
const sub = process.argv[2]
const rest = process.argv.slice(3)
switch (sub) {
  case 'render':
    await runRender(rest)
    break
  case 'sfx':
    await runSfx(rest)
    break
  default:
    console.error('usage: node verify-output.mjs <render|sfx> [args...]')
    process.exit(2)
}
