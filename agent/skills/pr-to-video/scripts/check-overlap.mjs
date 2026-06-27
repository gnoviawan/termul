#!/usr/bin/env node

// check-overlap.mjs — the single-rule rendered overlap gate.
//
// RULE: flatten every layer except the background onto one plane (ignore
// z-index / stacking entirely) — no two foreground paint atoms may intersect.
//
// A "paint atom" is an element that actually puts pixels on screen:
//   - a text block   (the nearest block-level ancestor of a non-whitespace
//                     text node — inline spans are attributed to their block)
//   - a media box    (<img> / <video> / <canvas> / <svg>)
//   - a surface      (an element painting its own background / border)
// Backgrounds and decoration are excluded (see EXCLUSIONS). Everything left
// is measured in a REAL browser — the scene file is loaded standalone in
// headless Chrome (same probe mechanism the render pipeline trusts: GSAP CDN
// + brand tokens + @font-face injected, timeline seeked to probe times), so
// flex/grid layout, runtime GSAP transforms and real font metrics are all
// resolved. No static CSS guessing.
//
// EXCLUSIONS (each one is the reason the old 8-check perception gate drowned
// in false positives — kept to the minimum that makes the one rule sound):
//   1. decorative subtree     — class chain matches DECO_RX (superset of the
//                               keepout list in captions.mjs: + underline /
//                               divider / rule / accent / line / connector /
//                               arrow / caret / cursor — connectors cross
//                               boxes by design)
//   2. background layers      — full-bleed boxes (≥85% of BOTH canvas dims)
//   3. invisible at probe     — effective opacity < 0.5 (entering/exiting
//                               content mid-fade is not occlusion), display:
//                               none, off-canvas
//   4. DOM nesting            — ancestor/descendant pairs (composition, not
//                               collision: text inside its own card)
//   5. containment placement  — intersection ≥90% of the smaller box when the
//                               larger is a surface/media (an element placed
//                               ON a panel is design; text-over-text never is)
//   6. transients             — a pair must intersect at ≥2 of the 3 probe
//                               times to be a violation. A single-probe hit is
//                               a mid-tween crossing (slide-in transit), and
//                               is reported separately as a transient, not a
//                               violation. Real layout overlaps are static —
//                               they persist across probes.
//
// Geometry constants (ALL of them — this gate has one rule, not one rule per
// constant):
//   MIN_OVERLAP_PX = 4   — intersection must be ≥4px deep on BOTH axes.
//                          Sub-4px is line-height kiss / antialias, invisible
//                          at 1920×1080. This is a measurement epsilon, not a
//                          tolerance.
//   CONTAIN_FRAC   = 0.9 — exclusion 5 threshold.
//   FULL_BLEED     = 0.85— exclusion 2 threshold.
//   MIN_SIDE_PX    = 8   — atoms thinner than this on both axes are hairlines
//                          (accent bars, rules), never occluders.
//   VIS_OPACITY    = 0.5 — exclusion 3 threshold.
//   PROBE_RATIOS   = 0.4 / 0.7 / 0.92 of scene duration (entry settled / mid /
//                          climax hold — same sampling the old gate used).
//
// Browser bootstrap: puppeteer-core resolved from the workspace / project
// node_modules (walk-up). `--ensure-deps` installs it once (`npm i --no-save
// puppeteer-core`, no Chrome download). The Chrome binary itself is reused
// from the hyperframes browser cache (~/.cache/hyperframes/chrome — populated
// by `hyperframes doctor` / first capture) or the standard puppeteer cache
// (~/.cache/puppeteer), or $PUPPETEER_EXECUTABLE_PATH. This gate never
// downloads a browser.
//
// Usage:
//   node check-overlap.mjs --group-spec ./group_spec.json --hyperframes . \
//        [--scene scene_2[,scene_3]] [--json] [--gsap-cdn <url>]
//   node check-overlap.mjs --ensure-deps     # one-time, from the workspace root
//
// Exit codes:
//   0 — no violations (transients, if any, are printed but do not block)
//   1 — at least one persistent foreground overlap
//   2 — gate could not run (no puppeteer module / no Chrome binary / bad args).
//       NOT a soft skip: preflight treats 2 as blocking, with the remedy in
//       stderr (`--ensure-deps`, `npx hyperframes doctor`).

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readDims } from './lib/dimensions.mjs'

// ---------- argv ----------
const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
}
const boolFlag = (name) => argv.includes(`--${name}`)

const asJson = boolFlag('json')
const ensureDepsMode = boolFlag('ensure-deps')
const sceneFilter = (flag('scene', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const GSAP_CDN = flag('gsap-cdn', 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js')

// ---------- constants ----------
const MIN_OVERLAP_PX = 4
const CONTAIN_FRAC = 0.9
const FULL_BLEED_FRAC = 0.85
const MIN_SIDE_PX = 8
const VIS_OPACITY = 0.5
const PROBE_RATIOS = [0.4, 0.7, 0.92]
const PERSIST_HITS = 2

// ---------- puppeteer resolution ----------
function loadPuppeteer(projectRoot) {
  const bases = [
    pathToFileURL(join(process.cwd(), 'noop.mjs')).href,
    pathToFileURL(join(projectRoot || process.cwd(), 'noop.mjs')).href,
    import.meta.url
  ]
  for (const base of bases) {
    for (const name of ['puppeteer-core', 'puppeteer']) {
      try {
        const req = createRequire(base)
        return { mod: req(name), name }
      } catch {
        /* next */
      }
    }
  }
  return null
}

function findChromeBinary() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH
  if (envPath && existsSync(envPath)) return envPath
  // Both roots use the @puppeteer/browsers cache layout:
  //   <root>/<family>/<platform>-<build>/<dir>/<binary>
  const roots = [
    join(homedir(), '.cache', 'hyperframes', 'chrome'),
    join(homedir(), '.cache', 'puppeteer')
  ]
  const families = ['chrome-headless-shell', 'chrome'] // shell first: faster boot
  for (const family of families) {
    for (const root of roots) {
      const base = join(root, family)
      if (!existsSync(base)) continue
      let versions
      try {
        versions = readdirSync(base)
      } catch {
        continue
      }
      for (const ver of versions.sort().reverse()) {
        let inner
        try {
          inner = readdirSync(join(base, ver))
        } catch {
          continue
        }
        for (const sub of inner) {
          const dir = join(base, ver, sub)
          for (const bin of [
            'chrome-headless-shell',
            join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
            'chrome'
          ]) {
            const p = join(dir, bin)
            if (existsSync(p)) return p
          }
        }
      }
    }
  }
  return null
}

// ---------- --ensure-deps mode ----------
if (ensureDepsMode) {
  let pp = loadPuppeteer(null)
  if (!pp) {
    console.log('check-overlap: puppeteer-core not resolvable — installing (npm i --no-save) ...')
    try {
      execSync('npm install --no-save --no-audit --no-fund puppeteer-core', {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000
      })
    } catch (e) {
      console.error(
        `✗ check-overlap --ensure-deps: npm install failed: ${e.message?.split('\n')[0]}`
      )
      process.exit(2)
    }
    pp = loadPuppeteer(null)
    if (!pp) {
      console.error(
        '✗ check-overlap --ensure-deps: puppeteer-core still not resolvable after install'
      )
      process.exit(2)
    }
  }
  const needsBinary = pp.name === 'puppeteer-core'
  const chrome = needsBinary ? findChromeBinary() : '(bundled by puppeteer)'
  if (needsBinary && !chrome) {
    console.error(
      '✗ check-overlap --ensure-deps: no Chrome binary in ~/.cache/hyperframes/chrome or ~/.cache/puppeteer — run `npx hyperframes doctor` once'
    )
    process.exit(2)
  }
  console.log(`✓ check-overlap deps ready: module=${pp.name}, chrome=${chrome}`)
  process.exit(0)
}

// ---------- load group_spec ----------
const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
const projectRoot = resolve(flag('hyperframes', '.'))
if (!existsSync(groupSpecPath)) {
  console.error(`✗ check-overlap: group_spec.json missing at ${groupSpecPath}`)
  process.exit(2)
}
const groupSpec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
const { width: CANVAS_W, height: CANVAS_H } = readDims(groupSpec)
const fontFaceCss = (groupSpec.font_face_css || '').trim()
const brandTokensCss = (groupSpec.brand_tokens_css || '').trim()

// ---------- browser bootstrap ----------
const unavailable = (reason) => {
  const out = {
    status: 'unavailable',
    reason,
    violations: [],
    transients: [],
    scenes_scanned: 0
  }
  if (asJson) console.log(JSON.stringify(out, null, 2))
  console.error(`✗ check-overlap: ${reason}`)
  console.error(
    '  → run `node check-overlap.mjs --ensure-deps` from the workspace root (installs puppeteer-core, no browser download); Chrome itself comes from `npx hyperframes doctor`'
  )
  process.exit(2)
}

const pp = loadPuppeteer(projectRoot)
if (!pp) unavailable('puppeteer-core not resolvable from workspace/project node_modules')
let executablePath = null
if (pp.name === 'puppeteer-core') {
  executablePath = findChromeBinary()
  if (!executablePath) unavailable('no Chrome binary found (hyperframes/puppeteer caches empty)')
}
const puppeteer = pp.mod.default ?? pp.mod
const headless = executablePath && executablePath.includes('chrome-headless-shell') ? 'shell' : true
const browser = await puppeteer.launch({
  ...(executablePath ? { executablePath } : {}),
  headless,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
})

// ---------- DOM-side probe ----------
// Runs inside the page at one seeked frame. Self-contained. Returns the raw
// overlapping pairs for this frame; persistence is aggregated outside.
const PROBE = function probe(cfg, CANVAS_W, CANVAS_H) {
  const out = []
  const DECO_RX = new RegExp(cfg.decoRx, 'i')

  const effOpacity = (el) => {
    let o = 1
    let p = el
    while (p && p.nodeType === 1) {
      const v = parseFloat(getComputedStyle(p).opacity)
      if (!Number.isNaN(v)) o *= v
      p = p.parentElement
    }
    return o
  }
  const chainHas = (el, fn) => {
    let p = el
    while (p && p.nodeType === 1) {
      if (fn(p)) return true
      p = p.parentElement
    }
    return false
  }
  const isDecor = (el) =>
    chainHas(el, (p) => DECO_RX.test(Array.from(p.classList || []).join(' ') + ' ' + (p.id || '')))
  const isExcluded = (el) => chainHas(el, (p) => p.getAttribute('aria-hidden') === 'true')
  const selectorFor = (el) => {
    if (el.id) return '#' + el.id
    const cls = Array.from(el.classList).filter((c) => /^s\d+-/.test(c))
    const base = cls.length
      ? el.tagName.toLowerCase() + '.' + cls.join('.')
      : el.tagName.toLowerCase()
    return base
  }
  const clipRect = (r) => {
    const left = Math.max(r.left, 0)
    const top = Math.max(r.top, 0)
    const right = Math.min(r.right, CANVAS_W)
    const bottom = Math.min(r.bottom, CANVAS_H)
    return { left, top, right, bottom, width: right - left, height: bottom - top }
  }
  const round = (v) => Math.round(v * 10) / 10

  // Stable per-element uid so pair identity survives across probe frames.
  window.__ovlSeq = window.__ovlSeq || 0
  const uidOf = (el) => {
    if (!el.dataset.ovlUid) el.dataset.ovlUid = String(++window.__ovlSeq)
    return el.dataset.ovlUid
  }

  // ---- collect paint atoms ----
  const atoms = new Map() // uid -> atom
  const addAtom = (el, kind) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    if (effOpacity(el) < cfg.visOpacity) return
    if (isDecor(el) || isExcluded(el)) return
    const raw = el.getBoundingClientRect()
    if (raw.width < cfg.minSidePx && raw.height < cfg.minSidePx) return
    const r = clipRect(raw)
    if (r.width <= 0 || r.height <= 0) return // off-canvas
    if (r.width >= CANVAS_W * cfg.fullBleedFrac && r.height >= CANVAS_H * cfg.fullBleedFrac) return // background layer
    const uid = uidOf(el)
    const prev = atoms.get(uid)
    if (prev) {
      if (!prev.kinds.includes(kind)) prev.kinds.push(kind)
      return
    }
    atoms.set(uid, { el, uid, kinds: [kind], rect: r, selector: selectorFor(el) })
  }

  // text atoms: nearest block-level ancestor of each non-whitespace text node
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let tn
  while ((tn = walker.nextNode())) {
    if (!tn.textContent.trim()) continue
    let blk = tn.parentElement
    while (blk && blk !== document.body && getComputedStyle(blk).display.startsWith('inline')) {
      blk = blk.parentElement
    }
    if (blk && blk !== document.body) addAtom(blk, 'text')
  }
  // media atoms
  for (const el of document.querySelectorAll('img, video, canvas, svg')) addAtom(el, 'media')
  // surface atoms: own background / border paint
  const colorAlpha = (c) => {
    const m = (c || '').match(/rgba?\(([^)]+)\)/)
    if (!m) return 0
    const ch = m[1].split(',').map((x) => parseFloat(x))
    return ch.length === 4 ? ch[3] : 1
  }
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue // svg internals: the <svg> is the atom
    const cs = getComputedStyle(el)
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && colorAlpha(cs.borderTopColor) >= 0.5
    const hasBgImage = cs.backgroundImage && cs.backgroundImage !== 'none'
    if (colorAlpha(cs.backgroundColor) >= 0.5 || hasBorder || hasBgImage) addAtom(el, 'surface')
  }

  // ---- pairwise intersection (z flattened: stacking order is ignored) ----
  const list = Array.from(atoms.values())
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i]
      const B = list[j]
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue // nesting = composition
      const left = Math.max(A.rect.left, B.rect.left)
      const top = Math.max(A.rect.top, B.rect.top)
      const right = Math.min(A.rect.right, B.rect.right)
      const bottom = Math.min(A.rect.bottom, B.rect.bottom)
      const iw = right - left
      const ih = bottom - top
      if (iw < cfg.minOverlapPx || ih < cfg.minOverlapPx) continue
      const areaA = A.rect.width * A.rect.height
      const areaB = B.rect.width * B.rect.height
      const smaller = Math.min(areaA, areaB)
      const frac = smaller > 0 ? (iw * ih) / smaller : 1
      const bothText =
        A.kinds.length === 1 &&
        A.kinds[0] === 'text' &&
        B.kinds.length === 1 &&
        B.kinds[0] === 'text'
      // containment = placement on a surface/media; text-over-text is never placement
      if (frac >= cfg.containFrac && !bothText) continue
      const fmt = (X) => ({
        selector: X.selector,
        kinds: X.kinds,
        rect: {
          left: round(X.rect.left),
          top: round(X.rect.top),
          width: round(X.rect.width),
          height: round(X.rect.height)
        }
      })
      out.push({
        pair_uid: A.uid < B.uid ? `${A.uid}|${B.uid}` : `${B.uid}|${A.uid}`,
        a: fmt(A),
        b: fmt(B),
        overlap: { left: round(left), top: round(top), width: round(iw), height: round(ih) },
        frac_of_smaller: Math.round(frac * 100) / 100
      })
    }
  }
  return out
}

// ---------- per-scene probe loop ----------
const violations = []
const transients = []
const cleanupPaths = []
let scenesScanned = 0
let scenesSkipped = 0
let scenesNoTimeline = 0

try {
  for (const grp of groupSpec.groups || []) {
    for (const [sid, scene] of Object.entries(grp.scenes || {})) {
      if (sceneFilter.length && !sceneFilter.includes(sid)) continue
      const compRel = `compositions/${sid}.html`
      const compPath = join(projectRoot, compRel)
      if (!existsSync(compPath)) {
        scenesSkipped++
        if (!asJson) console.error(`  skipped ${sid}: ${compRel} not found`)
        continue
      }
      const sceneHtml = readFileSync(compPath, 'utf8')
      const tmplMatch = sceneHtml.match(/<template[^>]*>([\s\S]*?)<\/template>/)
      if (!tmplMatch) {
        scenesSkipped++
        if (!asJson) console.error(`  skipped ${sid}: no <template> found`)
        continue
      }

      const probeTimes = PROBE_RATIOS.map((r) => +(scene.estimatedDuration_s * r).toFixed(3))
      const probePath = join(projectRoot, `_probe-overlap-${sid}.html`)
      cleanupPaths.push(probePath)
      writeFileSync(
        probePath,
        `<!doctype html>
<html><head>
<meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${CANVAS_W}px;height:${CANVAS_H}px;overflow:hidden;background:#fff;font-family:system-ui,sans-serif;}
${brandTokensCss}
${fontFaceCss}
</style>
<script src="${GSAP_CDN}"></script>
</head>
<body>
${tmplMatch[1]}
</body></html>`
      )

      let page
      try {
        page = await browser.newPage()
        await page.setViewport({ width: CANVAS_W, height: CANVAS_H, deviceScaleFactor: 1 })
        await page.goto(`file://${probePath}`, { waitUntil: 'networkidle0', timeout: 30_000 })
        await page.evaluate(() =>
          document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true
        )
        const tlReady = await page.evaluate(
          (sid) =>
            new Promise((res) => {
              const start = Date.now()
              const tick = () => {
                if (window.gsap && window.__timelines && window.__timelines[sid]) return res(true)
                if (Date.now() - start > 5000) return res(false)
                setTimeout(tick, 50)
              }
              tick()
            }),
          sid
        )
        if (!tlReady) {
          scenesNoTimeline++
          if (!asJson)
            console.error(`  ⚠ ${sid}: timeline never registered — probing t=0 frame only`)
        }

        const byPair = new Map() // pair_uid -> { hit times, worst sample }
        const cfg = {
          decoRx:
            '(?:^|[-_\\s])(?:bg|background|dot-?grid|mesh|gradient|swell|ambient|texture|noise|scanline|surface|overlay|halo|glow|frame|pin|corner-?pin|deco|star-?burst|burst|ring|stripe|rect|shadow|pulse|ripple|measure|probe|hidden|scrim|backdrop|veil|fog|grain|underline|divider|rule|accent|line|connector|arrow|caret|cursor)(?:[-_\\s]|$)',
          visOpacity: VIS_OPACITY,
          minSidePx: MIN_SIDE_PX,
          minOverlapPx: MIN_OVERLAP_PX,
          containFrac: CONTAIN_FRAC,
          fullBleedFrac: FULL_BLEED_FRAC
        }
        for (const t of tlReady ? probeTimes : [0]) {
          // seek(t, false): suppressEvents=false so onUpdate-driven content
          // (discrete-text-sequence, ASR glow) is applied at the seeked frame.
          // Then emulate the runtime's clip windowing: the probe page has no
          // framework runtime, so [data-start]/[data-duration] media clips
          // (image A swapped for image B in the same slot) would all render at
          // once and false-positive as overlap. Hide clips outside their
          // window — touching only elements WE hid (data-ovl-hid marker), so
          // GSAP-driven visibility (autoAlpha) is never overridden.
          await page.evaluate(
            (sid, t) => {
              const tl = window.__timelines && window.__timelines[sid]
              if (tl) tl.seek(t, false)
              for (const el of document.querySelectorAll('[data-start]')) {
                const start = parseFloat(el.getAttribute('data-start'))
                if (Number.isNaN(start)) continue
                const durRaw = el.getAttribute('data-duration')
                const dur = durRaw == null ? NaN : parseFloat(durRaw)
                const inWindow = t >= start && (Number.isNaN(dur) || t < start + dur)
                if (!inWindow) {
                  if (!el.dataset.ovlHid) {
                    el.dataset.ovlHid = '1'
                    el.style.visibility = 'hidden'
                  }
                } else if (el.dataset.ovlHid) {
                  delete el.dataset.ovlHid
                  el.style.visibility = ''
                }
              }
            },
            sid,
            t
          )
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          )
          await new Promise((r) => setTimeout(r, 60))
          const pairs = await page.evaluate(PROBE, cfg, CANVAS_W, CANVAS_H)
          for (const p of pairs) {
            const prev = byPair.get(p.pair_uid)
            if (!prev) {
              byPair.set(p.pair_uid, { sample: p, times: [t] })
            } else {
              prev.times.push(t)
              const area = (x) => x.overlap.width * x.overlap.height
              if (area(p) > area(prev.sample)) prev.sample = p
            }
          }
        }

        for (const { sample, times } of byPair.values()) {
          const row = {
            scene_id: sid,
            file: compRel,
            type: 'foreground-overlap',
            a: sample.a,
            b: sample.b,
            overlap: sample.overlap,
            frac_of_smaller: sample.frac_of_smaller,
            probe_times_s: times,
            hits: times.length
          }
          if (times.length >= PERSIST_HITS || !tlReady) violations.push(row)
          else transients.push(row)
        }
        scenesScanned++
      } finally {
        if (page) await page.close().catch(() => {})
      }
    }
  }
} finally {
  await browser.close().catch(() => {})
  for (const p of cleanupPaths) rmSync(p, { force: true })
}

// ---------- report ----------
const result = {
  status: 'ok',
  canvas: { width: CANVAS_W, height: CANVAS_H },
  probe_ratios: PROBE_RATIOS,
  min_overlap_px: MIN_OVERLAP_PX,
  scenes_scanned: scenesScanned,
  scenes_skipped: scenesSkipped,
  scenes_no_timeline: scenesNoTimeline,
  violations,
  transients
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(violations.length === 0 ? 0 : 1)
}

const fmtRow = (v) =>
  `  [${v.scene_id}] ${v.a.selector} (${v.a.kinds.join('+')}) × ${v.b.selector} (${v.b.kinds.join('+')})\n` +
  `    a: (${v.a.rect.left},${v.a.rect.top} ${v.a.rect.width}×${v.a.rect.height})  b: (${v.b.rect.left},${v.b.rect.top} ${v.b.rect.width}×${v.b.rect.height})\n` +
  `    overlap: ${v.overlap.width}×${v.overlap.height} at (${v.overlap.left},${v.overlap.top}), ${Math.round(v.frac_of_smaller * 100)}% of smaller, at t=${v.probe_times_s.join('/')}s (${v.hits}/${PROBE_RATIOS.length} probes)`

if (violations.length === 0) {
  console.log(
    `✓ check-overlap: ${scenesScanned} scene(s) probed at ${PROBE_RATIOS.join('/')} of duration — no foreground overlap` +
      (scenesNoTimeline
        ? ` (⚠ ${scenesNoTimeline} scene(s) probed at t=0 only — timeline missing)`
        : '')
  )
  if (transients.length) {
    console.log(
      `  ${transients.length} transient crossing(s) (single-probe, mid-tween — not blocking):`
    )
    for (const v of transients) console.log(fmtRow(v))
  }
  process.exit(0)
}

console.error(
  `✗ check-overlap: ${violations.length} foreground overlap(s) across ${new Set(violations.map((v) => v.scene_id)).size} scene(s) — no two foreground boxes may intersect (z-flattened)`
)
for (const v of violations) console.error(fmtRow(v))
if (transients.length) {
  console.error(
    `  ${transients.length} transient crossing(s) (single-probe, mid-tween — not blocking):`
  )
  for (const v of transients) console.error(fmtRow(v))
}
console.error(
  `\n  → fix by root cause: move one box / put both in a flow (flex/grid) container / stagger their visible windows.` +
    `\n    There is no opt-out — DOM-nested children (text inside its own card) are already ignored; every other flagged pair must clear.`
)
process.exit(1)
