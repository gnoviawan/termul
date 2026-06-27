#!/usr/bin/env node
// transitions.mjs — merges three former Phase-4c scripts behind one subcommand dispatcher.
//
//   inject       ← inject-transitions.mjs       (Tier-B/Tier-A wrapper overlap + GSAP stamp)
//   verify       ← verify-transitions.mjs        (deterministic gate over injector output)
//   check-bridge ← check-bridge-continuity.mjs   (Step-6 preflight gate for Tier-A bridges)
//
// Each subcommand reads its args from process.argv AFTER the subcommand token
// (i.e. process.argv.slice(3)). Original per-subcommand usage:
//   node transitions.mjs inject       --group-spec ./group_spec.json --hyperframes .
//   node transitions.mjs verify       --group-spec ./group_spec.json --index ./index.html
//   node transitions.mjs check-bridge --hyperframes . --group-spec ./group_spec.json

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readDims } from './lib/dimensions.mjs'
import { transitionsByName } from './lib/transition-registry.mjs'

// ===========================================================================
// inject ← inject-transitions.mjs
async function runInject(argv) {
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
  }
  function die(msg) {
    console.error(`✗ inject-transitions.mjs: ${msg}`)
    process.exit(1)
  }

  const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
  const hyperframesDir = resolve(flag('hyperframes', '.'))
  const indexPath = join(hyperframesDir, 'index.html')

  if (!existsSync(groupSpecPath)) die(`group_spec.json not found at ${groupSpecPath}`)
  if (!existsSync(indexPath))
    die(`index.html not found at ${indexPath} — run assemble-index.mjs first`)

  let spec
  try {
    spec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
  } catch (e) {
    die(`group_spec.json parse: ${e.message}`)
  }

  // Slide transitions push a wrapper fully off-canvas, so the travel distance is
  // the canvas dimension along the slide axis (read from group_spec; landscape
  // default for pre-dims specs).
  const { width: CANVAS_W, height: CANVAS_H } = readDims(spec)

  const transitions = Array.isArray(spec.transitions) ? spec.transitions : []
  const rawInjectable = transitions.filter((t) => t.tier === 'b' || t.tier === 'a')

  let html = readFileSync(indexPath, 'utf8')

  if (rawInjectable.length === 0) {
    console.log(`✓ inject-transitions: 0 transitions to inject — index.html unchanged`)
    process.exit(0)
  }

  let txByName
  try {
    txByName = transitionsByName()
  } catch (e) {
    die(`transition registry: ${e.message}`)
  }

  // The authoritative VISUAL clip id set. Captions / voice / bgm / sfx also use
  // id="el-…" or data-composition-src, but they are not visual scene clips and
  // must not join the ping-pong transition track assignment.
  const visualIds = new Set()
  if (Array.isArray(spec.visual_clips) && spec.visual_clips.length > 0) {
    for (const v of spec.visual_clips) if (v?.id) visualIds.add(v.id)
  } else {
    for (const g of spec.groups || []) for (const sid of g.scene_ids || []) visualIds.add(sid)
  }
  if (visualIds.size === 0) die(`group_spec has no visual clips — cannot identify wrappers`)
  const sceneToVisual = spec.scene_to_visual || {}
  const normalizeClipId = (id) => (visualIds.has(id) ? id : sceneToVisual[id] || id)

  // ---------- parse VISUAL clip wrappers out of index.html ----------
  // assemble-index emits each scene clip as a stable multi-line block:
  //   <div\n  id="el-<sid>"\n  data-composition-id=...\n  data-composition-src=...\n
  //   data-start="X"\n  data-duration="Y"\n  data-track-index="0"\n ...></div>
  // We only keep clips whose id is a known visual clip — captions (el-captions)
  // and audio (el-<sid>-voice) are excluded. Play order comes from data-start ascending.
  const clipRe = /<div\s+id="el-([A-Za-z0-9_]+)"([\s\S]*?)><\/div>/g
  const clips = new Map() // visual_id -> { sid, start, duration, track, block }
  let cm
  while ((cm = clipRe.exec(html)) !== null) {
    const sid = cm[1]
    if (!visualIds.has(sid)) continue // skip captions / voice / bgm / sfx
    const block = cm[0]
    const attrs = cm[2]
    const num = (re) => {
      const m = attrs.match(re)
      return m ? Number(m[1]) : null
    }
    const start = num(/data-start="([\d.]+)"/)
    const duration = num(/data-duration="([\d.]+)"/)
    const track = num(/data-track-index="(\d+)"/)
    if (start == null || duration == null) {
      die(
        `scene clip #el-${sid} missing data-start/data-duration — assemble-index output malformed`
      )
    }
    clips.set(sid, { sid, start, duration, track: track ?? 0, block })
  }

  if (clips.size === 0)
    die(`no visual clip wrappers found in index.html for ids: ${[...visualIds].join(', ')}`)

  // Completeness guard against assemble-index emit drift. Every "HF-VISUAL-CLIP <id>"
  // marker (emitted by assemble-index.mjs immediately before each visual clip <div>)
  // whose id is a known visual clip MUST have been parsed by clipRe above. If the
  // <div id="el-<id>"> emit shape changes and the regex stops matching, this fails
  // loudly here instead of silently dropping a clip from the ping-pong track
  // reassignment below (which would surface much later as overlapping_clips_same_track).
  // Older index.html without the marker → markerIds empty → no-op (backward compatible).
  // Keep the marker string in lockstep with assemble-index.mjs.
  const markerIds = [...html.matchAll(/<!--\s*HF-VISUAL-CLIP\s+([A-Za-z0-9_]+)\b/g)]
    .map((m) => m[1])
    .filter((id) => visualIds.has(id))
  const missedIds = markerIds.filter((id) => !clips.has(id))
  if (missedIds.length)
    die(
      `visual-clip parse drift: assemble-index marked ${markerIds.length} visual clip(s) but the parser missed ${missedIds.join(', ')} — the <div id="el-<id>"> emit format changed; resync transitions.mjs with assemble-index.mjs`
    )

  // ---------- apply overlaps ----------
  const gsapLines = []
  const applied = []
  const skippedInternal = []
  for (const raw of rawInjectable) {
    const t = { ...raw, from: normalizeClipId(raw.from), to: normalizeClipId(raw.to) }
    if (t.from === t.to) {
      skippedInternal.push(raw)
      continue
    }
    const fromClip = clips.get(t.from)
    const toClip = clips.get(t.to)
    if (!fromClip || !toClip) {
      die(
        `transition ${t.from}→${t.to}: clip wrapper(s) not in index.html (from=${!!fromClip}, to=${!!toClip})`
      )
    }
    const dur = Number(t.duration_s) || 0.5

    // EXTEND-OUTGOING-ONLY overlap. The transition plays in [cut, cut + dur], where
    // `cut` is the incoming scene's start (= the outgoing scene's natural end, since
    // scenes tile). We extend ONLY the outgoing wrapper by `dur` so it lingers (held
    // final frame) across the window while the incoming — already present from `cut`
    // on the higher track — fades/pushes IN over it. We do NOT move any scene's
    // data-start, so voice/SFX/caption timing (all keyed to the original start_s)
    // stays perfectly in sync. Overlap window == tween window == `dur`. No dead frames.
    const T = Number(toClip.start.toFixed(3)) // cut = incoming start
    fromClip.duration = Number((fromClip.duration + dur).toFixed(3))

    gsapLines.push(...buildGsap(t, dur, T))
    applied.push({ ...t, T, durApplied: dur })
  }

  // ---------- mandatory 0/1 ping-pong track reassignment ----------
  // Walk scene clips in play order (start asc, stable by sid) and alternate track 0/1.
  // Overlapping neighbors always land on different tracks; non-adjacent clips reuse a
  // track but never overlap, so overlapping_clips_same_track stays clean.
  const ordered = [...clips.values()].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : a.sid.localeCompare(b.sid)
  )
  ordered.forEach((c, i) => {
    c.track = i % 2
  })

  // ---------- rewrite each clip block in html ----------
  for (const c of clips.values()) {
    const nb = c.block
      .replace(/data-start="[\d.]+"/, `data-start="${c.start}"`)
      .replace(/data-duration="[\d.]+"/, `data-duration="${c.duration}"`)
      .replace(/data-track-index="\d+"/, `data-track-index="${c.track}"`)
    if (nb === c.block && c.block.includes(`data-track-index`)) {
      // attrs unchanged is fine; only fail if the block had no track attr to rewrite
    }
    html = html.replace(c.block, nb)
  }

  // ---------- inject GSAP after the master timeline creation ----------
  // assemble-index emits:  window.__timelines["main"] = gsap.timeline({ paused: true });
  const masterAnchor = 'window.__timelines["main"] = gsap.timeline({ paused: true });'
  if (!html.includes(masterAnchor)) {
    die(`master timeline anchor not found in index.html — expected: ${masterAnchor}`)
  }
  const block = [
    masterAnchor,
    '      // ── scene transitions (injected by inject-transitions.mjs) ──',
    '      (function () { var tl = window.__timelines["main"];',
    ...gsapLines.map((l) => '        ' + l),
    '      })();'
  ].join('\n')
  html = html.replace(masterAnchor, block)

  writeFileSync(indexPath, html)

  // ---------- summary ----------
  const nB = applied.filter((a) => a.tier === 'b').length
  const nA = applied.filter((a) => a.tier === 'a').length
  console.log(
    `✓ inject-transitions: ${applied.length} transition(s) stamped into index.html (tier-b ${nB}, tier-a ${nA})`
  )
  if (skippedInternal.length) {
    console.log(`  skipped ${skippedInternal.length} intra-visual transition(s)`)
  }
  for (const a of applied) {
    const dir = a.direction ? ` ${a.direction}` : ''
    const tag = a.tier === 'a' ? ` [Tier-A bridge:${a.bridge_id || '?'}]` : ''
    console.log(
      `  ${a.from}→${a.to}: ${a.type}${dir} ${a.durApplied}s @ T=${a.T}s${tag} (from ext +${a.durApplied}s, to start→${a.T})`
    )
  }
  const trackSummary = [...clips.values()]
    .sort((a, b) => a.start - b.start)
    .map((c) => `${c.sid}[t${c.track} ${c.start}→${Number((c.start + c.duration).toFixed(3))}]`)
    .join(' ')
  console.log(`  tracks: ${trackSummary}`)

  // ===========================================================================
  // build the GSAP lines for one transition.
  function buildGsap(t, dur, T) {
    const OLD = `"#el-${t.from}"`
    const NEW = `"#el-${t.to}"`

    // Tier A: the worker authored the morph INSIDE the two scenes (outgoing tweens the
    // bridge element to a handoff pose; incoming starts there, holds for the seam, then
    // continues). The harness only crossfades the WRAPPERS so bg/title swap while the
    // aligned bridge element reads as one continuous element. No registry template.
    if (t.tier === 'a') {
      return [
        `tl.to(${OLD}, { opacity: 0, duration: ${dur}, ease: "power1.inOut" }, ${T});`,
        `tl.fromTo(${NEW}, { opacity: 0 }, { opacity: 1, duration: ${dur}, ease: "power1.inOut" }, ${T});`
      ]
    }

    const rec = txByName.get(t.type)
    if (!rec) die(`transition ${t.from}→${t.to}: type "${t.type}" not in registry`)

    // pick template: directional types have horizontal/vertical variants
    let template
    const extra = {}
    if (rec.directions && rec.directions.length > 0) {
      const dir = (t.direction || rec.default_direction || rec.directions[0]).toUpperCase()
      const vertical = dir === 'UP' || dir === 'DOWN'
      template = vertical ? rec.gsap_template_vertical : rec.gsap_template_horizontal
      if (!template)
        die(`transition ${t.type}: missing ${vertical ? 'vertical' : 'horizontal'} template`)
      if (vertical) {
        const dy = dir === 'UP' ? -CANVAS_H : CANVAS_H
        extra.__DY__ = String(dy)
        extra.__DYIN__ = String(-dy) // incoming enters from the opposite edge
      } else {
        const dx = dir === 'LEFT' ? -CANVAS_W : CANVAS_W
        extra.__DX__ = String(dx)
        extra.__DXIN__ = String(-dx)
      }
    } else {
      template = rec.gsap_template
      if (!template) die(`transition ${t.type}: missing gsap_template`)
    }

    const subs = {
      __OLD__: OLD,
      __NEW__: NEW,
      __T__: String(T),
      __DUR__: String(dur),
      ...extra
    }
    return template.map((line) => {
      let out = line
      for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v)
      return out
    })
  }
}

// ===========================================================================
// verify ← verify-transitions.mjs
async function runVerify(argv) {
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
  }

  const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
  const indexPath = resolve(flag('index', './index.html'))

  const fail = []
  function bail(msg) {
    console.error(`✗ verify-transitions.mjs: ${msg}`)
    process.exit(1)
  }

  if (!existsSync(groupSpecPath)) bail(`group_spec.json not found at ${groupSpecPath}`)
  if (!existsSync(indexPath)) bail(`index.html not found at ${indexPath}`)

  let spec
  try {
    spec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
  } catch (e) {
    bail(`group_spec.json parse: ${e.message}`)
  }
  const transitions = Array.isArray(spec.transitions) ? spec.transitions : []
  const rawInjectable = transitions.filter((t) => t.tier === 'b' || t.tier === 'a')

  // Authoritative VISUAL clip id set (same as the injector) — captions/voice/bgm/sfx
  // are excluded from the visual track-overlap invariant.
  const visualIds = new Set()
  if (Array.isArray(spec.visual_clips) && spec.visual_clips.length > 0) {
    for (const v of spec.visual_clips) if (v?.id) visualIds.add(v.id)
  } else {
    for (const g of spec.groups || []) for (const sid of g.scene_ids || []) visualIds.add(sid)
  }
  const sceneToVisual = spec.scene_to_visual || {}
  const normalizeClipId = (id) => (visualIds.has(id) ? id : sceneToVisual[id] || id)
  const injectable = rawInjectable
    .map((t) => ({ ...t, from: normalizeClipId(t.from), to: normalizeClipId(t.to) }))
    .filter((t) => t.from !== t.to)

  const html = readFileSync(indexPath, 'utf8')

  // ---------- parse VISUAL clip wrappers (only known visual ids) ----------
  const clipRe = /<div\s+id="el-([A-Za-z0-9_]+)"([\s\S]*?)><\/div>/g
  const clips = new Map()
  let cm
  while ((cm = clipRe.exec(html)) !== null) {
    if (!visualIds.has(cm[1])) continue // skip captions / voice / bgm / sfx
    const attrs = cm[2]
    const num = (re) => {
      const m = attrs.match(re)
      return m ? Number(m[1]) : null
    }
    clips.set(cm[1], {
      sid: cm[1],
      start: num(/data-start="([\d.]+)"/),
      duration: num(/data-duration="([\d.]+)"/),
      track: num(/data-track-index="(\d+)"/) ?? 0
    })
  }

  const EPS = 0.011 // ms-rounding tolerance (prep rounds to 3 dp)
  const overlaps = (a, b) =>
    a.start < b.start + b.duration - EPS && b.start < a.start + a.duration - EPS

  // ---------- (4) GLOBAL no-same-track-overlap ----------
  const all = [...clips.values()]
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]
      const b = all[j]
      if (a.track === b.track && overlaps(a, b)) {
        fail.push(
          `same-track overlap: ${a.sid}[t${a.track} ${a.start}→${(a.start + a.duration).toFixed(3)}] ` +
            `and ${b.sid}[t${b.track} ${b.start}→${(b.start + b.duration).toFixed(3)}] — lint would reject this`
        )
      }
    }
  }

  // ---------- per-transition (1)(2)(3) ----------
  // Isolate the injected transition block so the tween-reference check only looks there.
  const blockMatch = html.match(/scene transitions \(injected[\s\S]*?\}\)\(\);/)
  const txBlock = blockMatch ? blockMatch[0] : ''
  if (injectable.length > 0 && !txBlock) {
    fail.push(
      `group_spec has ${injectable.length} transition(s) but no injected transition block in index.html`
    )
  }

  for (const t of injectable) {
    const from = clips.get(t.from)
    const to = clips.get(t.to)
    if (!from || !to) {
      fail.push(`transition ${t.from}→${t.to}: wrapper(s) missing (from=${!!from}, to=${!!to})`)
      continue
    }
    // (1) tween references both ids
    if (!txBlock.includes(`"#el-${t.from}"`) || !txBlock.includes(`"#el-${t.to}"`)) {
      fail.push(
        `transition ${t.from}→${t.to}: injected block does not reference both #el-${t.from} and #el-${t.to}`
      )
    }
    // (2) overlap ≈ duration_s (extend-outgoing-only: fromEnd - toStart ≈ dur)
    const fromEnd = from.start + from.duration
    const overlapAmt = Number((fromEnd - to.start).toFixed(3))
    const dur = Number(t.duration_s) || 0.5
    if (Math.abs(overlapAmt - dur) > EPS) {
      fail.push(
        `transition ${t.from}→${t.to}: overlap ${overlapAmt}s ≠ duration ${dur}s ` +
          `(from end ${fromEnd.toFixed(3)}, to start ${to.start})`
      )
    }
    // (3) overlapping wrappers on different tracks
    if (from.track === to.track) {
      fail.push(`transition ${t.from}→${t.to}: both wrappers on track ${from.track} — must differ`)
    }
  }

  // ---------- report ----------
  if (fail.length) {
    console.error(`✗ verify-transitions: ${fail.length} invariant failure(s):`)
    for (const f of fail) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log(
    `✓ verify-transitions: ${injectable.length} transition(s) verified ` +
      `(overlap==duration, cross-track, both ids referenced, no same-track overlap)`
  )
}

// ===========================================================================
// check-bridge ← check-bridge-continuity.mjs
async function runCheckBridge(argv) {
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
  }

  const hyperframesDir = resolve(flag('hyperframes', '.'))
  const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
  const compositionsDir = join(hyperframesDir, 'compositions')
  const outPath = join(hyperframesDir, 'bridge_check.json')

  if (!existsSync(groupSpecPath)) {
    console.error(`✗ check-bridge-continuity: group_spec.json not found at ${groupSpecPath}`)
    process.exit(1)
  }

  let spec
  try {
    spec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
  } catch (e) {
    console.error(`✗ check-bridge-continuity: group_spec.json parse: ${e.message}`)
    process.exit(1)
  }

  const bridges = (Array.isArray(spec.transitions) ? spec.transitions : []).filter(
    (t) => t.tier === 'a'
  )

  if (bridges.length === 0) {
    console.log(`✓ check-bridge-continuity: 0 tier-a bridges — nothing to check`)
    writeFileSync(outPath, JSON.stringify({ bridges: [], ok: true }, null, 2) + '\n')
    process.exit(0)
  }

  const fatals = []
  const warnings = []
  const rows = []

  function readScene(sid) {
    const p = join(compositionsDir, `${sid}.html`)
    if (!existsSync(p)) {
      fatals.push(`${sid}: compositions/${sid}.html missing — worker did not produce it`)
      return null
    }
    return readFileSync(p, 'utf8')
  }

  // Find the element carrying data-bridge-id="<id>" and return its opening tag + class list.
  function findBridgeEl(html, bridgeId) {
    const re = new RegExp(`<[a-zA-Z][^>]*\\bdata-bridge-id=["']${bridgeId}["'][^>]*>`, 'g')
    const matches = html.match(re) || []
    return matches
  }

  // Static-hidden check on the opening tag's inline style.
  function inlineHidden(tag) {
    const styleM = tag.match(/style=["']([^"']*)["']/i)
    if (!styleM) return false
    const s = styleM[1].toLowerCase()
    return (
      /display\s*:\s*none/.test(s) ||
      /visibility\s*:\s*hidden/.test(s) ||
      /opacity\s*:\s*0(\.0+)?\s*(;|$)/.test(s)
    )
  }

  for (const b of bridges) {
    const id = b.bridge_id
    const row = { from: b.from, to: b.to, bridge_id: id, ok: true, notes: [] }
    if (!id) {
      fatals.push(
        `${b.from}→${b.to}: tier-a transition has no bridge_id (prep should have caught this)`
      )
      row.ok = false
      rows.push(row)
      continue
    }

    for (const [sid, role] of [
      [b.from, 'from'],
      [b.to, 'to']
    ]) {
      const html = readScene(sid)
      if (html == null) {
        row.ok = false
        continue
      }
      const tags = findBridgeEl(html, id)
      if (tags.length === 0) {
        fatals.push(
          `${sid} (${role}): no element with data-bridge-id="${id}" — the shared bridge element is missing. ` +
            `Both bridged scenes must contain <... data-bridge-id="${id}" ...>.`
        )
        row.ok = false
        continue
      }
      if (tags.length > 1) {
        fatals.push(
          `${sid} (${role}): ${tags.length} elements carry data-bridge-id="${id}" — must be exactly one`
        )
        row.ok = false
        continue
      }
      if (inlineHidden(tags[0])) {
        fatals.push(
          `${sid} (${role}): the bridge element data-bridge-id="${id}" has a static display:none/visibility:hidden/opacity:0 — it would be invisible at the seam. Make it visible (GSAP can still animate it in/out).`
        )
        row.ok = false
      }
      row.notes.push(`${role}=${sid}:found`)
    }

    rows.push(row)
  }

  writeFileSync(
    outPath,
    JSON.stringify({ bridges: rows, ok: fatals.length === 0, warnings }, null, 2) + '\n'
  )

  if (fatals.length) {
    console.error(`✗ check-bridge-continuity: ${fatals.length} fatal(s):`)
    for (const f of fatals) console.error(`  - ${f}`)
    console.error(
      `  → re-dispatch the worker(s) owning the affected scene(s); both bridged scenes must carry the same data-bridge-id.`
    )
    process.exit(1)
  }

  console.log(
    `✓ check-bridge-continuity: ${bridges.length} tier-a bridge(s) verified (element present + visible in both scenes)`
  )
  for (const r of rows) console.log(`  ${r.from}→${r.to}: bridge="${r.bridge_id}" ✓`)
  if (warnings.length) for (const w of warnings) console.log(`  ⚠ ${w}`)
}

// ===========================================================================
// dispatcher
const sub = process.argv[2]
const rest = process.argv.slice(3)
switch (sub) {
  case 'inject':
    await runInject(rest)
    break
  case 'verify':
    await runVerify(rest)
    break
  case 'check-bridge':
    await runCheckBridge(rest)
    break
  default:
    console.error('usage: node transitions.mjs <inject|verify|check-bridge> [args...]')
    process.exit(2)
}
