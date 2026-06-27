#!/usr/bin/env node
// hoist-videos.mjs — deterministic host-root <video> assembly (Step 7 prelude).
//
// THE FRAMEWORK RULE (hyperframes-core references/variables-and-media.md,
// NON-NEGOTIABLE): <video> must be a DIRECT child of the host composition
// root in index.html. The runtime only registers + drives media that is a
// direct root child — a <video> inside a scene's <template> (or wrapped in
// any div) is never seeked/decoded and renders blank. lint/validate/inspect
// cannot see this; it used to surface only at finalize snapshots, costing a
// full repair round + footage degraded to stills.
//
// So scene workers never write <video>. Instead they author the poster
// <img> in the slot and DECLARE the footage on it:
//
//   <img class="s3-demo clip" src="public/demo-poster.jpg"
//        data-video-src="public/demo.mp4"      ← required; relative, public/
//        data-video-offset="0.6"               ← optional; scene-local start (s), default 0
//        data-video-duration="5"               ← optional; cap (s), default = to scene end
//        data-video-media-start="2.0"          ← optional; trim into the source (s)
//        data-video-loop="off"                 ← optional; default loops
//        data-start=... data-duration=...>     ← the poster's own clip window, as usual
//
// This script runs AFTER assemble-index + inject-transitions:
//   1. Scans compositions/scene_*.html for [data-video-src] declarations.
//   2. Loads each declaring scene standalone in headless Chrome (same probe
//      machinery as check-overlap.mjs: GSAP CDN + brand tokens + @font-face,
//      timeline seeked to the video's start frame, [data-start]/[data-duration]
//      clip windows emulated) and MEASURES the poster's rendered rect +
//      border-radius. No hand-derived geometry.
//   3. Emits one host-root <video class="clip"> per declaration into
//      index.html, inside a sentinel block (idempotent — re-runs replace it):
//        - global data-start/data-duration = scene slot start + local offset,
//          CLAMPED inside the scene's stable interval: after the incoming
//          transition ends, and ending at the scene's nominal end (outgoing
//          transitions animate the scene WRAPPER on the main timeline; a host
//          video would not follow a push/slide — outside the window the
//          in-scene poster shows instead, so seams never tear).
//        - absolute position = the measured rect; object-fit:cover; muted
//          playsinline (+ loop unless data-video-loop="off").
//        - data-track-index: free content lanes from 2 up (scenes occupy 0/1;
//          10/11/12 are voice/BGM/captions), greedy by time-overlap.
//
// Constraint the worker owns (contract #4): the poster slot must hold STILL
// during the video window — the hoisted video cannot follow in-scene GSAP
// transforms on the slot. Slot entry/exit animation belongs outside the
// declared window (use data-video-offset to start after the entry settles).
//
// Browser bootstrap is identical to check-overlap.mjs: puppeteer-core via
// walk-up resolution (--ensure-deps installs it once), Chrome reused from
// ~/.cache/hyperframes/chrome or ~/.cache/puppeteer; never downloads.
//
// Usage:
//   node hoist-videos.mjs --group-spec ./group_spec.json --hyperframes . [--json]
//
// Exit codes:
//   0 — hoisted N videos (or no declarations; any stale block is removed)
//   1 — a declaration is invalid (missing file / bad numbers / window too
//       small / element not measurable) — fix the scene file upstream
//   2 — browser unavailable (same remedy as check-overlap: --ensure-deps)

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
const asJson = argv.includes('--json')
const GSAP_CDN = flag('gsap-cdn', 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js')

const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
const projectRoot = resolve(flag('hyperframes', '.'))
const indexPath = resolve(flag('index', join(projectRoot, 'index.html')))

if (!existsSync(groupSpecPath)) {
  console.error(`✗ hoist-videos: group_spec.json missing at ${groupSpecPath}`)
  process.exit(1)
}
if (!existsSync(indexPath)) {
  console.error(`✗ hoist-videos: index.html missing at ${indexPath} (run assemble-index first)`)
  process.exit(1)
}
const groupSpec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
const { width: CANVAS_W, height: CANVAS_H } = readDims(groupSpec)
const fontFaceCss = (groupSpec.font_face_css || '').trim()
const brandTokensCss = (groupSpec.brand_tokens_css || '').trim()

const SENTINEL_START =
  '<!-- hoisted-videos:start (generated by hoist-videos.mjs — do not hand-edit) -->'
const SENTINEL_END = '<!-- hoisted-videos:end -->'
const SEAM_EPS = 0.05 // settle margin after an incoming transition (s)
const MIN_WINDOW_S = 0.3 // a visible window smaller than this is a declaration bug

// ---------- collect scene timing + transitions ----------
const sceneRow = new Map() // sid -> { start_s, duration_s }
for (const grp of groupSpec.groups || []) {
  for (const [sid, s] of Object.entries(grp.scenes || {})) {
    const start = Number(s.start_s)
    const dur = Number(s.estimatedDuration_s)
    if (isFinite(start) && isFinite(dur)) sceneRow.set(sid, { start_s: start, duration_s: dur })
  }
}
const incomingDur = new Map() // sid -> transition duration playing [start, start+dur]
for (const t of groupSpec.transitions || []) {
  const d = Number(t.duration_s)
  if (t.to && isFinite(d)) incomingDur.set(t.to, d)
}

// ---------- scan declarations ----------
const declarations = [] // { sid, ord, attrs }
const attrOf = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? m[1] : null
}
for (const sid of sceneRow.keys()) {
  const compPath = join(projectRoot, 'compositions', `${sid}.html`)
  if (!existsSync(compPath)) continue
  const html = readFileSync(compPath, 'utf8')
  let ord = 0
  for (const m of html.matchAll(/<img\b[^>]*\bdata-video-src\s*=\s*"[^"]*"[^>]*>/gi)) {
    const tag = m[0]
    declarations.push({
      sid,
      ord: ord++,
      src: attrOf(tag, 'data-video-src'),
      offset: parseFloat(attrOf(tag, 'data-video-offset') ?? '0'),
      capDur: attrOf(tag, 'data-video-duration')
        ? parseFloat(attrOf(tag, 'data-video-duration'))
        : null,
      mediaStart: attrOf(tag, 'data-video-media-start')
        ? parseFloat(attrOf(tag, 'data-video-media-start'))
        : null,
      loop: (attrOf(tag, 'data-video-loop') || '').toLowerCase() !== 'off'
    })
  }
  // a raw <video> in a scene is a contract violation (check-compositions also fatals it)
  if (/<video\b/i.test(html)) {
    console.error(
      `✗ hoist-videos: ${sid} contains a raw <video> — scenes must declare footage via data-video-src on the poster <img> (framework: nested <video> renders blank)`
    )
    process.exit(1)
  }
}

// ---------- strip stale block (always), exit early when nothing to hoist ----------
let indexHtml = readFileSync(indexPath, 'utf8')
const stripBlock = (s) => {
  const i = s.indexOf(SENTINEL_START)
  if (i < 0) return s
  const j = s.indexOf(SENTINEL_END)
  if (j < 0) return s
  // remove the whole sentinel region including surrounding line breaks
  const before = s.slice(0, i).replace(/[ \t]*$/, '')
  const after = s.slice(j + SENTINEL_END.length).replace(/^\n/, '')
  return before + after
}
indexHtml = stripBlock(indexHtml)

if (declarations.length === 0) {
  writeFileSync(indexPath, indexHtml)
  const out = { status: 'ok', hoisted: 0, videos: [] }
  if (asJson) console.log(JSON.stringify(out, null, 2))
  else console.log('✓ hoist-videos: no data-video-src declarations — nothing to hoist')
  process.exit(0)
}

// ---------- validate declarations ----------
for (const d of declarations) {
  if (!d.src || d.src.startsWith('/') || !/^public\//.test(d.src)) {
    console.error(
      `✗ hoist-videos: ${d.sid} declaration #${d.ord} — data-video-src must be a relative public/ path (got "${d.src}")`
    )
    process.exit(1)
  }
  if (!existsSync(join(projectRoot, d.src))) {
    console.error(`✗ hoist-videos: ${d.sid} declaration #${d.ord} — file not found: ${d.src}`)
    process.exit(1)
  }
  if (!isFinite(d.offset) || d.offset < 0) {
    console.error(`✗ hoist-videos: ${d.sid} declaration #${d.ord} — bad data-video-offset`)
    process.exit(1)
  }
}

// ---------- browser bootstrap (same mechanism as check-overlap.mjs) ----------
function loadPuppeteer(root) {
  const bases = [
    pathToFileURL(join(process.cwd(), 'noop.mjs')).href,
    pathToFileURL(join(root || process.cwd(), 'noop.mjs')).href,
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
  const roots = [
    join(homedir(), '.cache', 'hyperframes', 'chrome'),
    join(homedir(), '.cache', 'puppeteer')
  ]
  const families = ['chrome-headless-shell', 'chrome']
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
const unavailable = (reason) => {
  if (asJson) console.log(JSON.stringify({ status: 'unavailable', reason, hoisted: 0 }, null, 2))
  console.error(`✗ hoist-videos: ${reason}`)
  console.error(
    '  → run `node check-overlap.mjs --ensure-deps` from the workspace root (installs puppeteer-core); Chrome itself comes from `npx hyperframes doctor`'
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

// ---------- measure each declaring scene ----------
const bySid = new Map()
for (const d of declarations) {
  if (!bySid.has(d.sid)) bySid.set(d.sid, [])
  bySid.get(d.sid).push(d)
}

const videos = [] // emit rows
const cleanupPaths = []
let failed = null
try {
  for (const [sid, decls] of bySid) {
    const row = sceneRow.get(sid)
    const compPath = join(projectRoot, 'compositions', `${sid}.html`)
    const sceneHtml = readFileSync(compPath, 'utf8')
    const tmplMatch = sceneHtml.match(/<template[^>]*>([\s\S]*?)<\/template>/)
    if (!tmplMatch) {
      failed = `${sid}: no <template> found`
      break
    }
    const probePath = join(projectRoot, `_probe-hoist-${sid}.html`)
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

    const page = await browser.newPage()
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

    for (const d of decls) {
      // clamp the local window into the scene's stable interval
      const inDur = incomingDur.get(sid) || 0
      const startLocal = Math.max(d.offset, inDur > 0 ? inDur + SEAM_EPS : 0)
      let endLocal = row.duration_s // nominal scene end: outgoing transitions play after it
      if (d.capDur != null && isFinite(d.capDur))
        endLocal = Math.min(endLocal, startLocal + d.capDur)
      const windowS = endLocal - startLocal
      if (windowS < MIN_WINDOW_S) {
        failed = `${sid} declaration #${d.ord}: visible window ${windowS.toFixed(2)}s after clamping (incoming transition ${inDur}s) — widen data-video-offset/duration`
        break
      }
      // measure at the video's first visible frame (+ a hair, so entry settle is over)
      const measureT = Math.min(startLocal + 0.1, startLocal + windowS / 2)
      const rect = await page.evaluate(
        (sid, t, ord) => {
          const tl = window.__timelines && window.__timelines[sid]
          if (tl) tl.seek(t, false)
          // emulate runtime clip windows (same approach as check-overlap)
          for (const el of document.querySelectorAll('[data-start]')) {
            const start = parseFloat(el.getAttribute('data-start'))
            if (Number.isNaN(start)) continue
            const durRaw = el.getAttribute('data-duration')
            const dur = durRaw == null ? NaN : parseFloat(durRaw)
            const inWindow = t >= start && (Number.isNaN(dur) || t < start + dur)
            if (!inWindow) {
              if (!el.dataset.hvHid) {
                el.dataset.hvHid = '1'
                el.style.visibility = 'hidden'
              }
            } else if (el.dataset.hvHid) {
              delete el.dataset.hvHid
              el.style.visibility = ''
            }
          }
          const els = document.querySelectorAll('[data-video-src]')
          const el = els[ord]
          if (!el) return { error: 'declaration element not found in probe DOM' }
          const r = el.getBoundingClientRect()
          if (r.width < 8 || r.height < 8)
            return {
              error: `poster rect is ${Math.round(r.width)}x${Math.round(r.height)} at t=${t} (hidden or collapsed?)`
            }
          const cs = getComputedStyle(el)
          return {
            left: Math.round(r.left * 10) / 10,
            top: Math.round(r.top * 10) / 10,
            width: Math.round(r.width * 10) / 10,
            height: Math.round(r.height * 10) / 10,
            borderRadius: cs.borderRadius && cs.borderRadius !== '0px' ? cs.borderRadius : null,
            objectPosition: cs.objectPosition !== '50% 50%' ? cs.objectPosition : null
          }
        },
        sid,
        tlReady ? measureT : 0,
        d.ord
      )
      if (rect.error) {
        failed = `${sid} declaration #${d.ord}: ${rect.error}`
        break
      }
      videos.push({
        sid,
        ord: d.ord,
        src: d.src,
        global_start: Math.round((row.start_s + startLocal) * 1000) / 1000,
        duration: Math.round(windowS * 1000) / 1000,
        media_start: d.mediaStart,
        loop: d.loop,
        rect
      })
    }
    await page.close()
    if (failed) break
  }
} finally {
  await browser.close().catch(() => {})
  for (const p of cleanupPaths) rmSync(p, { force: true })
}
if (failed) {
  console.error(`✗ hoist-videos: ${failed}`)
  process.exit(1)
}

// ---------- track allocation: free content lanes from 2, greedy by time overlap ----------
videos.sort((a, b) => a.global_start - b.global_start)
const laneEnds = [] // lane i (track 2+i) -> last end time
for (const v of videos) {
  let lane = laneEnds.findIndex((end) => v.global_start >= end)
  if (lane < 0) {
    lane = laneEnds.length
    laneEnds.push(0)
  }
  laneEnds[lane] = v.global_start + v.duration
  v.track = 2 + lane
}

// ---------- emit ----------
const lines = [`      ${SENTINEL_START}`]
for (const v of videos) {
  const style = [
    'position:absolute',
    `left:${v.rect.left}px`,
    `top:${v.rect.top}px`,
    `width:${v.rect.width}px`,
    `height:${v.rect.height}px`,
    'object-fit:cover',
    ...(v.rect.objectPosition ? [`object-position:${v.rect.objectPosition}`] : []),
    ...(v.rect.borderRadius ? [`border-radius:${v.rect.borderRadius}`] : [])
  ].join('; ')
  lines.push(
    `      <video`,
    `        id="hv-${v.sid}-${v.ord}"`,
    `        class="clip"`,
    `        data-hoisted-from="${v.sid}"`,
    `        src="${v.src}"`,
    `        data-start="${v.global_start}"`,
    `        data-duration="${v.duration}"`,
    ...(v.media_start != null ? [`        data-media-start="${v.media_start}"`] : []),
    `        data-track-index="${v.track}"`,
    `        muted`,
    `        playsinline`,
    ...(v.loop ? [`        loop`] : []),
    `        style="${style}"`,
    `      ></video>`
  )
}
lines.push(`      ${SENTINEL_END}`)

// insert as a DIRECT child of the host root: right before the root's closing
// </div> (assemble-index emits it as the last `    </div>` before `<script>`)
const anchor = indexHtml.match(/\n(\s*)<\/div>\s*\n\s*<script>/)
if (!anchor) {
  console.error(
    '✗ hoist-videos: could not find host-root closing </div> before <script> in index.html'
  )
  process.exit(1)
}
const insertAt = anchor.index
indexHtml = indexHtml.slice(0, insertAt) + '\n\n' + lines.join('\n') + indexHtml.slice(insertAt)
writeFileSync(indexPath, indexHtml)

// ---------- report ----------
if (asJson) {
  console.log(JSON.stringify({ status: 'ok', hoisted: videos.length, videos }, null, 2))
} else {
  console.log(`✓ hoist-videos: ${videos.length} host-root <video> element(s) written to index.html`)
  for (const v of videos) {
    console.log(
      `    [${v.sid}] ${v.src} → global ${v.global_start}s +${v.duration}s, track ${v.track}, rect ${v.rect.width}x${v.rect.height}@(${v.rect.left},${v.rect.top})${v.loop ? ', loop' : ''}`
    )
  }
}
process.exit(0)
