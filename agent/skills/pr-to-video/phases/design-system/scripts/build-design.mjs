#!/usr/bin/env node
/**
 * build-design.mjs
 *
 * Merges site brand DNA (from `hyperframes capture` output) with a style
 * preset into a single design.html. design.html is the only artifact
 * downstream phases read.
 *
 * v3: replaces designlang dependency — reads hyperframes capture's native
 * schema directly (capture/extracted/{tokens,design-styles,animations,
 * fonts-manifest}.json + visible-text.txt). Material/imagery/voice/intent
 * labels are derived in-process by deriveSiteDna() and friends.
 *
 * Usage:
 *   node build-design.mjs <design-system-dir> [--capture <dir>] [--style <preset-name>]
 *                                              [--out <file>] [--out-scores <file>] [--no-emit]
 *
 * --capture:    path to hyperframes capture dir (default: <design-system-dir>/../capture).
 * --style:      force a preset (e.g. neo-brutalism, editorial). If omitted, auto-infers.
 * --out:        override design.html output path (default: <dir>/design.html).
 * --out-scores: where to write inference.json (default: <dir>/inference.json). Always written.
 * --no-emit:    run inference + write inference.json, but skip design.html / component rendering.
 *               Used by the design-system subagent for the "review before commit" pass:
 *               first run with --no-emit, read inference.json, decide whether to override
 *               the baseline winner, then re-run with --style <X> to emit.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverSourceUrl } from '../../../scripts/lib/capture-meta.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRESETS_DIR = path.resolve(__dirname, '..', 'style-presets')

// ═══════════════════ CLI ═════════════════════════════════
const argv = process.argv.slice(2)
const outDir = path.resolve(argv[0] || '.')
let cliCaptureDir = null,
  cliOut = null,
  cliStyle = null,
  cliOutScores = null,
  cliNoEmit = false,
  cliBrandPrimary = null
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--capture' && argv[i + 1]) cliCaptureDir = argv[++i]
  else if (argv[i] === '--out' && argv[i + 1]) cliOut = argv[++i]
  else if (argv[i] === '--style' && argv[i + 1]) cliStyle = argv[++i]
  else if (argv[i] === '--out-scores' && argv[i + 1]) cliOutScores = argv[++i]
  else if (argv[i] === '--no-emit') cliNoEmit = true
  // --brand-primary <hex>: the design-system agent's screenshot-based override
  // of the auto-classified brand primary (see inference.json.brand.candidates).
  else if (argv[i] === '--brand-primary' && argv[i + 1]) cliBrandPrimary = argv[++i]
}
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true })
}
if (!fs.statSync(outDir).isDirectory()) {
  console.error(`✗ ${outDir} is not a directory`)
  process.exit(1)
}

// Default capture dir: sibling to design-system/ — matches the PROJECT_DIR
// layout: PROJECT_DIR/capture/ (input) + PROJECT_DIR/design-system/ (output).
const captureDir = cliCaptureDir
  ? path.resolve(cliCaptureDir)
  : path.resolve(outDir, '..', 'capture')

const outFile = cliOut ? path.resolve(cliOut) : path.join(outDir, 'design.html')
const outScoresFile = cliOutScores
  ? path.resolve(cliOutScores)
  : path.join(outDir, 'inference.json')

function readJSONAbs(absPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'))
  } catch {
    return fallback
  }
}
function readTextAbs(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8')
  } catch {
    return ''
  }
}

// ═══════════════════ Read hyperframes capture ═════════════
const hfTokens = readJSONAbs(path.join(captureDir, 'extracted', 'tokens.json'), null)
if (!hfTokens) {
  console.error(
    `✗ ${path.join(captureDir, 'extracted', 'tokens.json')} not found. ` +
      `Run 'npx hyperframes capture <url> -o ${captureDir}' first.`
  )
  process.exit(1)
}
const hfDesignStyles = readJSONAbs(path.join(captureDir, 'extracted', 'design-styles.json'), {
  typography: [],
  spacing: { observed: [], baseUnit: 8 },
  radius: [],
  shadows: [],
  buttons: [],
  cards: [],
  nav: null
})
const hfAnimations = readJSONAbs(path.join(captureDir, 'extracted', 'animations.json'), null)
const hfVisibleText = readTextAbs(path.join(captureDir, 'extracted', 'visible-text.txt'))
const hfMeta = readJSONAbs(path.join(captureDir, 'meta.json'), null)

// Source URL discovery — shared with derive-context-pack.mjs via
// lib/capture-meta.mjs (grep CLAUDE.md/AGENTS.md/.cursorrules, fall back to
// reconstructing from meta.id host slug) so the two stay in lockstep.
const sourceUrl = discoverSourceUrl(captureDir, hfMeta)

// ═══════════════════ Color helpers ════════════════════════
function _normalizeHex(c) {
  if (!c) return ''
  const s = String(c).trim()
  if (s.startsWith('#')) {
    if (s.length === 4) {
      return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toUpperCase()
    }
    if (s.length === 7) return s.toUpperCase()
    return ''
  }
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return ''
  return (
    '#' + [m[1], m[2], m[3]].map((n) => parseInt(n).toString(16).padStart(2, '0')).join('')
  ).toUpperCase()
}
function _sat(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  if (!m) return 0
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  if (max === 0) return 0
  return (max - min) / max
}
function _lightness(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  if (!m) return 0.5
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
  return 0.299 * r + 0.587 * g + 0.114 * b
}
function _isGrayish(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  if (!m) return true
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  return max - min < 18
}
// HSL saturation + lightness (0..100). Used by the signal-based brand classifier.
function _hslSL(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  if (!m) return { s: 0, l: 0 }
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  const l = (max + min) / 2
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  }
  return { s: s * 100, l: l * 100 }
}
// Redmean perceptual color distance (0..~765) — used to keep secondary distinct.
function _redmean(a, b) {
  const x = String(a).match(/^#?([0-9a-f]{6})$/i)
  const y = String(b).match(/^#?([0-9a-f]{6})$/i)
  if (!x || !y) return 999
  const xr = [0, 2, 4].map((i) => parseInt(x[1].slice(i, i + 2), 16))
  const yr = [0, 2, 4].map((i) => parseInt(y[1].slice(i, i + 2), 16))
  const rm = (xr[0] + yr[0]) / 2
  const dr = xr[0] - yr[0],
    dg = xr[1] - yr[1],
    db = xr[2] - yr[2]
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

// ═══════════════════ Brand color derivation ═══════════════
// Brand primary = the chromatic color most used as an interactive / repeated
// FILL — validated against 17 real sites (signal-based classifier beats the
// legacy "first button bg" by ~17pts). Scoring (per capture colorStats entry):
//   score = bgCount*3 + interactiveBg*18 + areaBg*2 + sat*1.3 + log10(count)*4
//   + 400 if the color is an actual non-nav CTA background (decisive)
//   * 0.15 if a low-saturation light tint (section surface, not brand)
//   * 0.30 if text/logo-only (never a fill — kills the default link blue)
//   * 0.45 if near-black (dark surface/text, rarely the brand fill)
// Falls back to the legacy heuristic when colorStats is absent (old captures).
//
// Ambiguous sites (multi-color brands, or a brand whose color lives only in a
// logo / large section block) can't be resolved from CSS stats alone — the
// scored candidate pool + a `confidence` are emitted to inference.json so the
// design-system agent can look at the first-screen screenshot and override via
// `--brand-primary <hex>` (see guide.md "brand review"). `_brandChrom` stashes
// the ranked pool for that report.
let _brandChrom = null
function _brandClassify(stats, buttons) {
  const btnBg = new Set(buttons.map((b) => _normalizeHex(b.background || '')).filter(Boolean))
  return stats
    .map((v) => {
      const hex = _normalizeHex(v.hex)
      if (!/^#[0-9A-F]{6}$/.test(hex)) return null
      const { s: sat, l } = _hslSL(hex)
      const chromatic = (sat > 25 && l > 5 && l < 95) || (sat > 40 && v.interactiveBg > 0)
      if (!chromatic) return null
      let score =
        v.bgCount * 3 +
        v.interactiveBg * 18 +
        v.areaBg * 2 +
        sat * 1.3 +
        Math.log10(Math.max(1, v.count)) * 4
      if (btnBg.has(hex)) score += 400
      if (l > 85 && sat < 40) score *= 0.15
      if (v.bgCount === 0) score *= 0.3
      if (l < 12) score *= 0.45
      return {
        hex,
        sat,
        score: Number(score.toFixed(1)),
        bgCount: v.bgCount,
        interactiveBg: v.interactiveBg,
        count: v.count,
        onButton: btnBg.has(hex)
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
}
// Build the {primary, secondary, accent} triplet from the ranked pool. An
// explicit `primaryOverride` (the agent's screenshot pick) takes the top slot;
// secondary/accent are then derived around it.
function _tripletFromChrom(chrom, primaryOverride) {
  if (!chrom.length) return null
  const primary =
    primaryOverride && /^#[0-9A-F]{6}$/.test(primaryOverride) ? primaryOverride : chrom[0].hex
  const secondary = (
    chrom.find((x) => x.hex !== primary && _redmean(x.hex, primary) > 100) ||
    chrom.find((x) => x.hex !== primary) || { hex: primary }
  ).hex
  const taken = new Set([primary, secondary])
  const accent = (
    chrom.filter((x) => !taken.has(x.hex)).sort((a, b) => b.sat - a.sat)[0] || { hex: secondary }
  ).hex
  return { primary, secondary, accent }
}
// confidence in the auto-pick: ratio of the top score to the runner-up. A clear
// winner → high; a near-tie → low → the agent should review the screenshot.
function brandConfidence(chrom) {
  if (!chrom || chrom.length < 2) return { label: 'high', ratio: 99 }
  const top = chrom[0].score,
    second = chrom[1].score || 0.01
  const ratio = second > 0 ? top / second : 99
  const label = ratio >= 1.8 ? 'high' : ratio >= 1.25 ? 'medium' : 'low'
  return { label, ratio: Number(ratio.toFixed(2)) }
}

function deriveBrandColors() {
  const buttons = hfDesignStyles.buttons || []
  const stats = hfTokens.colorStats || []
  if (stats.length) {
    const chrom = _brandClassify(stats, buttons)
    if (chrom.length) {
      _brandChrom = chrom
      const override = cliBrandPrimary ? _normalizeHex(cliBrandPrimary) : null
      return _tripletFromChrom(chrom, override)
    }
  }

  // ── legacy fallback: first non-gray button bg, else highest-sat palette ──
  const palette = (hfTokens.colors || []).map(_normalizeHex).filter((c) => /^#[0-9A-F]{6}$/.test(c))

  let primary = null
  for (const b of buttons) {
    const bg = _normalizeHex(b.background || '')
    if (!bg) continue
    if (_isGrayish(bg)) continue
    if (bg === '#FFFFFF' || bg === '#000000') continue
    primary = bg
    break
  }
  if (!primary) {
    const sorted = palette.filter((c) => !_isGrayish(c)).sort((a, b) => _sat(b) - _sat(a))
    primary = sorted[0] || palette[0] || '#000000'
  }

  let secondary = null
  for (const c of palette) {
    if (c === primary) continue
    if (_isGrayish(c)) continue
    if (c === '#FFFFFF' || c === '#000000') continue
    secondary = c
    break
  }
  if (!secondary) secondary = primary

  const taken = new Set([primary, secondary])
  const accentCands = palette
    .filter((c) => !taken.has(c) && !_isGrayish(c))
    .sort((a, b) => _sat(b) - _sat(a))
  const accent = accentCands[0] || secondary

  return { primary, secondary, accent }
}

function deriveCanvasAndInk() {
  const cssVars = hfTokens.cssVariables || {}
  const canvasVarKeys = ['--background', '--bg', '--canvas', '--surface']
  const inkVarKeys = ['--foreground', '--text', '--ink', '--color-text']
  let canvas = null,
    ink = null
  for (const k of canvasVarKeys) {
    const h = _normalizeHex(cssVars[k])
    if (h) {
      canvas = h
      break
    }
  }
  for (const k of inkVarKeys) {
    const h = _normalizeHex(cssVars[k])
    if (h) {
      ink = h
      break
    }
  }
  const palette = (hfTokens.colors || [])
    .map(_normalizeHex)
    .filter((c) => /^#[0-9A-F]{6}$/.test(c))
    .map((c) => ({ c, L: _lightness(c) }))
    .sort((a, b) => b.L - a.L)
  if (!canvas) canvas = palette[0]?.c || '#FFFFFF'
  if (!ink) ink = palette[palette.length - 1]?.c || '#000000'
  return { canvas, ink }
}

function deriveMaterial() {
  const shadows = hfDesignStyles.shadows || []
  const radius = hfDesignStyles.radius || []
  const hasPill = radius.some((r) => /^(50%|9999px|99\d{2,}px)$/i.test(String(r)))
  const blurs = []
  let zeroBlurCount = 0
  let totalSegs = 0
  for (const s of shadows) {
    const segs = String(s.value || '').split(/,(?![^()]*\))/)
    for (const seg of segs) {
      if (/inset/.test(seg)) continue
      const lens = [...seg.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]))
      if (lens.length < 3) continue
      totalSegs++
      const blur = lens[2]
      blurs.push(blur)
      if (blur === 0 && (Math.abs(lens[0]) >= 3 || Math.abs(lens[1]) >= 3)) zeroBlurCount++
    }
  }
  const maxBlur = blurs.length ? Math.max(...blurs) : 0
  const palette = (hfTokens.colors || []).slice(0, 6).map(_normalizeHex).filter(Boolean)
  const avgSat = palette.length ? palette.map(_sat).reduce((a, b) => a + b, 0) / palette.length : 0
  if (zeroBlurCount > 0 && totalSegs > 0 && zeroBlurCount / totalSegs >= 0.3) return 'brutalist'
  if (hasPill && avgSat > 0.45) return 'playful'
  if (maxBlur > 24) return 'soft'
  if (maxBlur >= 4) return 'elevated'
  return 'flat'
}

function deriveImagery() {
  const svgs = hfTokens.svgs || []
  const sectionAssetUrls = new Set()
  for (const s of hfTokens.sections || []) {
    for (const u of s.assetUrls || []) sectionAssetUrls.add(u)
  }
  const urls = [...sectionAssetUrls]
  const photo = urls.filter((u) => /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u)).length
  const svg = svgs.length + urls.filter((u) => /\.svg(\?|$)/i.test(u)).length
  const video = urls.filter((u) => /\.(mp4|webm|mov)(\?|$)/i.test(u)).length
  if (video >= 3) return 'screen-recording'
  if (photo > svg * 1.5 && photo > 5) return 'photography'
  if (svg > photo) return 'flat-illustration'
  return 'mixed'
}

function deriveVoice() {
  const headings = (hfTokens.headings || []).filter((h) => (h.text || '').trim())
  const ctas = hfTokens.ctas || []
  const text = hfVisibleText.slice(0, 5000).toLowerCase()
  let upper = 0,
    title = 0,
    sentence = 0
  for (const h of headings) {
    const t = (h.text || '').trim()
    if (!t) continue
    if (t.length > 3 && t === t.toUpperCase() && /[A-Z]/.test(t)) upper++
    else if (
      t
        .split(/\s+/)
        .slice(0, 6)
        .filter((w) => /^[A-Z]/.test(w)).length >= 3
    )
      title++
    else sentence++
  }
  let headingStyle = 'Sentence case'
  if (upper >= Math.max(title, sentence) && upper > 0) headingStyle = 'UPPERCASE'
  else if (title > sentence) headingStyle = 'Title Case'
  const avgWords = headings.length
    ? headings.reduce((s, h) => s + (h.text || '').split(/\s+/).filter(Boolean).length, 0) /
      headings.length
    : 0
  const headingLengthClass = avgWords <= 5 ? 'tight' : avgWords >= 9 ? 'loose' : 'medium'
  const counts = {}
  for (const c of ctas) {
    const first = (c.text || '').trim().split(/\s+/)[0] || ''
    const verb = first.toLowerCase().replace(/[^a-z]/g, '')
    if (verb && verb.length >= 3) counts[verb] = (counts[verb] || 0) + 1
  }
  const ctaVerbs = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }))
  const youCount = (text.match(/\byou(r)?\b/g) || []).length
  const weCount = (text.match(/\bwe\b/g) || []).length
  let tone = 'neutral'
  if (youCount > weCount * 2.5) tone = 'direct'
  else if (weCount > youCount * 1.5) tone = 'warm'
  return {
    tone,
    headingStyle,
    headingLengthClass,
    ctaVerbs,
    sampleHeadings: headings.slice(0, 6).map((h) => h.text || '')
  }
}

function derivePageIntent() {
  const url = sourceUrl || ''
  const urlPath = url.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '')
  if (/\/pricing\b/i.test(urlPath)) return 'pricing'
  if (/\/blog\b|\/article\b|\/news\b/i.test(urlPath)) return 'blog-post'
  if (/\/docs?\b|\/guide\b|\/reference\b/i.test(urlPath)) return 'docs'
  if (/\/about\b/i.test(urlPath)) return 'about'
  if (/\/contact\b/i.test(urlPath)) return 'contact'
  if (urlPath === '' || urlPath === '/') return 'landing'
  const title = (hfTokens.title || '').toLowerCase()
  if (/pricing|plans?/.test(title)) return 'pricing'
  if (/blog|article|news/.test(title)) return 'blog-post'
  return 'landing'
}

function deriveEasingMap() {
  if (!hfAnimations) return {}
  const out = {}
  const seen = new Set()
  let idx = 0
  const reps = hfAnimations.representativeAnimations || []
  for (const anim of reps) {
    const t = anim.effectTiming || {}
    if (t.easing && t.easing !== 'linear' && !seen.has(t.easing)) {
      seen.add(t.easing)
      out[`e${idx++}`] = t.easing
    }
    for (const kf of anim.keyframes || []) {
      if (kf.easing && kf.easing !== 'linear' && !seen.has(kf.easing)) {
        seen.add(kf.easing)
        out[`e${idx++}`] = kf.easing
      }
    }
  }
  return out
}

// ═══════════════════ Synthesize designlang shape ══════════
// The rest of build-design.mjs (~2200 lines of rendering, scoring, inference
// emission) is unchanged — it reads tokens / motion / dna / voice / intent /
// brandHtml in designlang shape. We populate those vars from hyperframes
// capture data here so the downstream code stays put.

const _brand = deriveBrandColors()
const _surfaces = deriveCanvasAndInk()
const _voiceDerived = deriveVoice()
const _materialLabel = deriveMaterial()
const _imageryLabel = deriveImagery()
const _pageIntent = derivePageIntent()
const _easings = deriveEasingMap()

// Border strings synthesized from buttons / cards / nav. computeFeatures()
// regex-tests these for `[3-9]px solid` / `2px solid` / `1px solid` signals.
const _borderStrings = (() => {
  const seen = new Set()
  const out = []
  const push = (s) => {
    const norm = String(s || '').trim()
    if (!norm || norm === 'none' || seen.has(norm)) return
    if (/^\s*0px/.test(norm)) return
    seen.add(norm)
    out.push(norm)
  }
  for (const b of hfDesignStyles.buttons || []) push(b.border)
  for (const c of hfDesignStyles.cards || []) push(c.border)
  if (hfDesignStyles.nav?.border) push(hfDesignStyles.nav.border)
  return out
})()

// Prefix kept for error messages / log lines. v3 has no real prefix (single
// capture/ dir) so we derive a hostname-style label.
const prefix = (() => {
  if (sourceUrl) {
    const m = sourceUrl.match(/^https?:\/\/(?:www\.)?([^/]+)/)
    if (m) return m[1].replace(/\./g, '-')
  }
  return hfMeta?.id || 'capture'
})()

const tokens = {
  $metadata: {
    source: sourceUrl,
    title: hfTokens.title || '',
    description: hfTokens.description || '',
    generator: 'hyperframes-capture'
  },
  primitive: {
    color: {
      brand: {
        primary: { $value: _brand.primary, $type: 'color' },
        secondary: { $value: _brand.secondary, $type: 'color' }
      },
      background: { bg0: { $value: _surfaces.canvas, $type: 'color' } },
      text: { t0: { $value: _surfaces.ink, $type: 'color' } },
      neutral: Object.fromEntries(
        (hfTokens.colors || [])
          .slice(0, 8)
          .map(_normalizeHex)
          .filter(Boolean)
          .map((c, i) => [`n${i}`, { $value: c, $type: 'color' }])
      )
    },
    fontFamily: Object.fromEntries(
      (hfTokens.fonts || []).map((f, i) => [`f${i}`, { $value: f.family, $type: 'fontFamily' }])
    ),
    shadow: Object.fromEntries(
      (hfDesignStyles.shadows || [])
        .filter((s) => s.value && s.value !== 'none')
        .map((s, i) => [`sh${i}`, { $value: s.value, $type: 'shadow' }])
    ),
    radius: Object.fromEntries(
      (hfDesignStyles.radius || []).map((r, i) => [`r${i}`, { $value: r, $type: 'dimension' }])
    ),
    border: Object.fromEntries(
      _borderStrings.map((s, i) => [`b${i}`, { $value: s, $type: 'border' }])
    )
  }
}

const motion = {
  duration: {},
  easing: Object.fromEntries(
    Object.entries(_easings).map(([k, v]) => [k, { $value: v, $type: 'easing' }])
  )
}

const dna = {
  materialLanguage: {
    label: _materialLabel,
    confidence: 0.5,
    signals: [],
    metrics: {
      saturation:
        (hfTokens.colors || [])
          .slice(0, 5)
          .map(_normalizeHex)
          .filter(Boolean)
          .map(_sat)
          .reduce((a, b) => a + b, 0) / Math.max(1, Math.min(5, (hfTokens.colors || []).length)),
      shadowProfile: (hfDesignStyles.shadows || []).length === 0 ? 'none' : 'soft',
      hasPill: (hfDesignStyles.radius || []).some((r) => /^(50%|9999px)$/.test(String(r))),
      gradientCount: Object.values(hfTokens.cssVariables || {}).filter((v) =>
        /gradient/i.test(String(v))
      ).length
    }
  },
  imageryStyle: { label: _imageryLabel, confidence: 0.5 },
  backgroundPatterns: { labels: [], counts: {} },
  tagline: hfTokens.description || '',
  description: hfTokens.description || ''
}

const voice = _voiceDerived

const intent = {
  pageIntent: { type: _pageIntent, confidence: 0.5 },
  sectionRoles: {
    counts: (() => {
      const counts = {}
      for (const s of hfTokens.sections || []) {
        counts[s.type] = (counts[s.type] || 0) + 1
      }
      return counts
    })()
  }
}

// brand.html → empty. The 5-slot regex-scan finds no matches; tertiary /
// costume fall through to the algorithmic saturation pick — same degradation
// path designlang relies on when sites don't ship a brand book.
const brandHtml = ''

// ═══════════════════ Extract brand DNA ═══════════════════
// designlang token schema (verified against figma.com output):
//   $metadata.{source, generator, generatedAt, version}
//   primitive.color.{brand|neutral|background|text}.<key>.$value = "#hex"
//   primitive.fontFamily.f0.$value = "..."
//   primitive.shadow.shN.$value = "rgba(...) Npx Npx Npx Npx"
//   primitive.radius.rN.$value = "Npx"
//   semantic.color.{action,surface,text}.<key>.$value (may be a {color} ref)

function valueOf(node) {
  if (!node) return null
  if (typeof node === 'string') return node
  if (node.$value !== undefined) return node.$value
  if (node.value !== undefined) return node.value
  return null
}
const meta = tokens.$metadata || {}
// sourceUrl already declared by the hyperframes-capture translator block above.

const prim = tokens.primitive || {}
const primColors = prim.color || {}
const fontFamilies = Object.values(prim.fontFamily || {})
  .map(valueOf)
  .filter(Boolean)

// Pull all color hexes (across brand/neutral/background/text) into a flat list
function gatherColors(node) {
  const out = []
  for (const v of Object.values(node || {})) {
    const val = valueOf(v)
    if (typeof val === 'string' && /^#[0-9a-f]{3,6}$/i.test(val)) out.push(val)
    else if (typeof v === 'object' && v !== null && !v.$value) {
      out.push(...gatherColors(v))
    }
  }
  return out
}
const allColors = gatherColors(primColors)

function isLight(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  if (!m) return true
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b > 160
}

// HSV saturation of a hex color, 0..1.
function saturation(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  if (!m) return 0
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

// Brand triplet source priority:
//   1. brand.html (designlang's canonical classification — most authoritative)
//   2. tokens primitive.color.brand.{primary,secondary} (no accent here)
//   3. saturation-based heuristic over allColors (last resort)
function brandFromBrandHtml(html) {
  if (!html) return null
  const get = (cls) => {
    // <article class="brand-color brand-color-<role>"> ... <span class="big-swatch-hex">#XXXXXX</span>
    const re = new RegExp(
      `brand-color-${cls}[\\s\\S]*?big-swatch-hex"[^>]*>\\s*(#[0-9a-fA-F]{3,6})`
    )
    const m = html.match(re)
    return m ? m[1].toLowerCase() : null
  }
  const primary = get('primary')
  const secondary = get('secondary')
  const accent = get('accent')
  // tertiary + costume support designhtml-class presets (5-slot alias system).
  // Brands rarely declare them in brand.html — when absent, fallbacks below kick in.
  const tertiary = get('tertiary')
  const costume = get('costume')
  if (!primary && !secondary && !accent && !tertiary && !costume) return null
  return { primary, secondary, accent, tertiary, costume }
}
const brandFromHtml = brandFromBrandHtml(brandHtml)

let primaryHex =
  brandFromHtml?.primary || valueOf(primColors.brand?.primary) || allColors[0] || '#000000'
let secondaryHex =
  brandFromHtml?.secondary ||
  valueOf(primColors.brand?.secondary) ||
  allColors.find((c) => c !== primaryHex) ||
  primaryHex

let accentHex =
  brandFromHtml?.accent ||
  (() => {
    // Fallback algorithm: highest-saturation color distinct from primary/secondary
    const taken = new Set([primaryHex.toLowerCase(), secondaryHex.toLowerCase()])
    const candidates = allColors
      .filter((c) => !taken.has(c.toLowerCase()))
      .map((c) => ({ c, s: saturation(c) }))
      .filter((o) => o.s > 0.5)
      .sort((a, b) => b.s - a.s)
    return candidates[0]?.c || secondaryHex
  })()

// Background and text: prefer first entry of those buckets if present
const bgList = gatherColors(primColors.background || {})
const txList = gatherColors(primColors.text || {})
let canvasHex = bgList[0] || (isLight(primaryHex) ? '#ffffff' : '#0f0f0f')
let inkHex = txList[0] || (isLight(canvasHex) ? '#111111' : '#ffffff')

// ─── 5-slot alias system (tertiary + costume) ────────────────────
// designhtml-class presets (peoples-platform, etc.) reference 5 brand alias
// slots in their §B: primary / secondary / tertiary / accent / costume.
// 3-slot presets (the existing 22) don't reference tertiary/costume — they
// inherit the defaults below as no-ops.
//
// tertiary: second authority surface / bridge stratum hue.
//   1. brand.html declares brand-color-tertiary  → take it
//   2. saturation-pick from full palette          → highest-sat non-overlap
//   3. fallback to accentHex                      → degrades to accent-as-surface
let tertiaryHex =
  brandFromHtml?.tertiary ||
  (() => {
    const taken = new Set(
      [primaryHex, secondaryHex, accentHex, canvasHex, inkHex].map((c) => c.toLowerCase())
    )
    const candidates = allColors
      .filter((c) => !taken.has(c.toLowerCase()))
      .map((c) => ({ c, s: saturation(c) }))
      .filter((o) => o.s > 0.3)
      .sort((a, b) => b.s - a.s)
    return candidates[0]?.c || accentHex
  })()

// costume: second light surface (cream frames, raised window faces, soft chrome).
//   1. brand.html declares brand-color-costume    → take it
//   2. canvasHex                                  → degrades to canvas-equals-costume
//      (preset §B can still synthesize a warm tint via color-mix in CSS)
let costumeHex = brandFromHtml?.costume || canvasHex

// ─── Decoration colors (used by brutalism + maximalist presets) ──────
// Auto-pick 4 vibrant colors from the site's full palette, with hue diversity.
// Fall back to brutalism canonical 4-color set if site is too monochrome.
function hue(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  if (!m) return 0
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min
  if (d === 0) return 0
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}
const decoColors = (() => {
  const FALLBACK = ['#F7CB46', '#99E885', '#C0F7FE', '#FE90E8'] // yellow / green / blue / pink
  const taken = new Set(
    [primaryHex, secondaryHex, accentHex, canvasHex, inkHex].map((c) => c.toLowerCase())
  )
  const candidates = allColors
    .filter((c) => !taken.has(c.toLowerCase()))
    .map((c) => ({ c, s: saturation(c), h: hue(c) }))
    .filter((o) => o.s > 0.4)
    .sort((a, b) => b.s - a.s)
  // Hue-diverse pick: bucket by 90deg quadrants (warm / lime / cool / magenta).
  const buckets = [[], [], [], []]
  for (const { c, h } of candidates) {
    const bucket = Math.floor((h % 360) / 90)
    if (buckets[bucket].length < 1) buckets[bucket].push(c)
  }
  const picked = buckets.flat()
  while (picked.length < 4) picked.push(FALLBACK[picked.length])
  return picked.slice(0, 4)
})()

const brandName = (() => {
  const host = sourceUrl
    .replace(/^https?:\/\//, '')
    .replace(/\/.*/, '')
    .replace(/^www\./, '')
  return host ? host.split('.')[0].replace(/\b\w/g, (c) => c.toUpperCase()) : prefix
})()
const description = dna?.description || meta.description || ''
const materialLabel = dna?.materialLanguage?.label || 'unknown'
// pageIntent lives on `intent.pageIntent.type` (intent.json shape), not on
// `dna` — the original designlang split kept them in separate files. Our
// translator mirrors that split.
const intentLabel = intent?.pageIntent?.type || dna?.pageIntent?.type || 'unknown'

// Signature gradient: synthesize a 3-color linear gradient from the brand
// triplet. Conic / radial site gradients are too busy for video bg, so we
// compose a fresh linear one here for downstream use.
let signatureGradient = `linear-gradient(135deg, ${primaryHex} 0%, ${secondaryHex} 50%, ${accentHex} 100%)`

// Voice signals (used both in §5 and for auto-inference)
const voiceTone = voice?.tone || ''
const voiceHeading = voice?.headingStyle || ''
const voiceCtaVerbs = (voice?.ctaVerbs || []).map((v) => v.value || v).slice(0, 8)
const sampleHeadings = (voice?.sampleHeadings || []).slice(0, 6)

// ═══════════════════ Load all presets ════════════════════
// Each preset is a directory under style-presets/:
//   style-presets/<name>/
//   ├── preset.md              ← preset-meta + §A/§B/§D/§E/§G/§H/§I
//   └── components/<id>.md     ← one paste-ready component per file (raw body, no markers)
// The parser synthesizes §F by concatenating every components/*.md file in alphabetical
// order and wrapping each in <!-- COMPONENT: <id> --> markers, so downstream code
// (design.html render, emit-chunks anchor scan) sees the same structure as before.
const presets = (() => {
  if (!fs.existsSync(PRESETS_DIR)) {
    console.error(`✗ No style-presets/ directory at ${PRESETS_DIR}`)
    process.exit(1)
  }
  return fs
    .readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => parsePreset(path.join(PRESETS_DIR, e.name)))
})()

if (presets.length === 0) {
  console.error(
    `✗ No presets found in ${PRESETS_DIR}. Each preset must be a directory containing preset.md + components/<id>.md files.`
  )
  process.exit(1)
}

// ═══════════════════ Component frontmatter parser ════════
// Minimal YAML subset: top-level `key: value` lines only. Supports:
//   - bare strings:           surface: paper
//   - comma-separated lists:  composes: triple-stamp, grain-tooth
//   - bracketed lists:        slots: [headline, sub]
//   - integers:               weight: 700
//   - null / ~ / empty:       optional_field: ~
// Quoted strings have surrounding quotes stripped. Nesting / multiline / refs
// are not supported — keep frontmatter flat.
function parseComponentFrontmatter(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const m = line.match(/^\s*([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i)
    if (!m) continue
    const [, key, rawVal] = m
    const val = rawVal.trim()
    if (val === '' || val === '~' || val === 'null') {
      out[key] = null
    } else if (/^\[.*\]$/.test(val)) {
      out[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else if (val.includes(',')) {
      out[key] = val
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else if (/^-?\d+$/.test(val)) {
      out[key] = parseInt(val, 10)
    } else if (val === 'true' || val === 'false') {
      out[key] = val === 'true'
    } else {
      out[key] = val.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

// ═══════════════════ Preset parser ═══════════════════════
function parsePreset(presetDir) {
  const presetMd = path.join(presetDir, 'preset.md')
  if (!fs.existsSync(presetMd)) {
    console.error(`✗ ${presetDir} missing preset.md`)
    process.exit(1)
  }
  const raw = fs.readFileSync(presetMd, 'utf8')
  // Frontmatter is a fenced ```preset-meta { JSON } ``` block at top of file.
  const fmMatch = raw.match(/```preset-meta\n([\s\S]+?)\n```\n([\s\S]*)$/)
  if (!fmMatch) {
    console.error(`✗ ${presetMd} missing \`\`\`preset-meta block`)
    process.exit(1)
  }
  let meta
  try {
    meta = JSON.parse(fmMatch[1])
  } catch (e) {
    console.error(`✗ ${presetMd} preset-meta is invalid JSON: ${e.message}`)
    process.exit(1)
  }
  const body = fmMatch[2]

  // Parse §A-§I sections by heading (preset.md never contains §F; we synthesize it below).
  const sections = {}
  const headingRe = /^##\s+§([A-Z])\s+(.+?)$/gm
  const positions = []
  let m
  while ((m = headingRe.exec(body))) {
    positions.push({ key: m[1], title: m[2], start: m.index, headerLen: m[0].length })
  }
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i]
    const next = positions[i + 1]
    const content = body.slice(cur.start + cur.headerLen, next ? next.start : body.length).trim()
    sections[cur.key] = { title: cur.title, content }
  }
  if (sections.F) {
    console.error(
      `✗ ${presetMd} declares §F inline — §F is now sourced from ${presetDir}/components/<id>.md files. Move components out and remove the §F heading.`
    )
    process.exit(1)
  }

  // Components: one file per id, filename (sans .md) IS the id. Body is raw HTML.
  // Order is alphabetical by filename so design.html and chunks are deterministic.
  const componentsDir = path.join(presetDir, 'components')
  const components = []
  if (fs.existsSync(componentsDir)) {
    const files = fs
      .readdirSync(componentsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
    for (const f of files) {
      const id = f.replace(/\.md$/, '')
      if (!/^[a-z0-9-]+$/.test(id)) {
        console.error(`✗ ${componentsDir}/${f}: component id must match [a-z0-9-]+`)
        process.exit(1)
      }
      const raw = fs.readFileSync(path.join(componentsDir, f), 'utf8')
      // Optional YAML-subset frontmatter at top of file:
      //   ---
      //   surface: paper
      //   composes: triple-stamp, grain-tooth
      //   role: statement
      //   avoids_same_scene: framed-stamp, end-stamp
      //   slots: [headline, sub]
      //   ---
      // designhtml-class presets (peoples-platform, …) use this to surface
      // surface / composition / pairing metadata to the plan agent via
      // chunks/index.json. Existing components without frontmatter still work —
      // the meta field is null and downstream omits it.
      let compMeta = null
      let bodyText = raw
      const fmMatch = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/)
      if (fmMatch) {
        compMeta = parseComponentFrontmatter(fmMatch[1])
        bodyText = fmMatch[2]
      }
      const block = bodyText.trim()
      if (!block) {
        console.error(`✗ ${componentsDir}/${f}: empty component file`)
        process.exit(1)
      }
      components.push({ name: id, block, meta: compMeta })
    }
  }
  if (components.length === 0) {
    console.error(`✗ ${presetDir} has no components — add at least one components/<id>.md file`)
    process.exit(1)
  }
  // Synthesize §F so downstream rendering code (renderComponents, emit-chunks anchor scan)
  // sees the same shape as the legacy single-file format. When a component has
  // frontmatter, we emit one extra HTML comment line right after the COMPONENT
  // marker — emit-chunks.mjs greps that line out and writes the fields into
  // chunks/index.json.components[]. Comments without frontmatter skip the line
  // (zero impact on existing 22 presets).
  sections.F = {
    title: 'Components (paste-ready, use brand vars from §B)',
    content: components
      .map((c) => {
        const metaLine = c.meta ? `<!-- COMPONENT-META: ${JSON.stringify(c.meta)} -->\n\n` : ''
        return `<!-- COMPONENT: ${c.name} -->\n\n${metaLine}${c.block}\n\n<!-- /COMPONENT -->`
      })
      .join('\n\n')
  }

  return {
    name: meta.name,
    // Preset-owned palette (R2). Slots: canvas/surface/ink/primary/accent/secondary,
    // each { value, constraint?, lock?: "anchor", alias?: "<slot>" }. Consumed as a
    // fallback when the capture yielded no colors — see the pickPreset() callsite.
    palette: meta.palette || null,
    label: meta.label || meta.name,
    fingerprint: meta.fingerprint || {},
    matchSignals: meta.match_signals || [],
    // Semantic hints for the LLM-review pass. Empty arrays = preset hasn't
    // declared them yet (parser-tolerant; build still works).
    bestFor: Array.isArray(meta.best_for) ? meta.best_for : [],
    avoidFor: Array.isArray(meta.avoid_for) ? meta.avoid_for : [],
    // Hard runtime / environment requirements. Each entry is checked at
    // pickPreset() time; any missing requirement zeroes the preset's combined
    // score and surfaces a capabilities_missing[] list in inference.json so
    // the subagent can auto-install or report. See checkCapabilities() below.
    requiresCapabilities: Array.isArray(meta.requires_capabilities)
      ? meta.requires_capabilities
      : [],
    // Optional preset-native chrome fonts. When declared, build-design.mjs
    // injects an extra Google Fonts <link> and renderComponents() switches
    // §6 to dual-column (brand-applied | preset-native). See §I CSS for
    // .preset-native-scope and chromeFonts schema in preset-meta JSON.
    chromeFonts: meta.chromeFonts || null,
    sections,
    components,
    rawBody: body
  }
}

// ═══════════════════ Capability detection ═════════════════
// A capability requirement is satisfied when its kind-specific check passes:
//   block_installed: BOTH `verify_file` AND `verify_lib` exist on disk.
//                    `verify_file` alone is not enough — `hyperframes add` writes
//                    the block HTML but the lib/*.iife.js is shipped separately
//                    by some blocks, so we check both. Missing → subagent should
//                    run `auto_install` command (if non-null) to materialise it.
//   env_var_set:     process.env[var] is set + non-empty.
// Paths in verify_* are resolved relative to process.cwd() — that's the project
// root for the pipeline. build-design.mjs is invoked from project root, not
// from the design-system/ dir, so relative paths Just Work.
function checkCapabilities(preset) {
  const missing = []
  for (const req of preset.requiresCapabilities) {
    if (req.kind === 'block_installed') {
      const fileOk = req.verify_file ? fs.existsSync(path.resolve(req.verify_file)) : true
      const libOk = req.verify_lib ? fs.existsSync(path.resolve(req.verify_lib)) : true
      if (!fileOk || !libOk) {
        missing.push({
          kind: req.kind,
          block: req.block,
          missing_files: [!fileOk ? req.verify_file : null, !libOk ? req.verify_lib : null].filter(
            Boolean
          ),
          auto_install: req.auto_install || null,
          alternates: req.alternates || []
        })
      }
    } else if (req.kind === 'env_var_set') {
      const val = process.env[req.var]
      if (!val || !val.trim()) {
        missing.push({
          kind: req.kind,
          var: req.var,
          reason: req.reason || null,
          auto_install: req.auto_install || null
        })
      }
    } else {
      // Unknown capability kind — surface but don't gate (forward-compatible).
      missing.push({ kind: req.kind, unknown: true, raw: req })
    }
  }
  return missing
}

// ═══════════════════ Style auto-inference ════════════════
// Score each preset's match_signals against detected site features.
// Each signal contributes 0..1 * its weight when matched.
function detectSiteFeatures() {
  // Collect raw CSS-like strings to grep against
  const shadowStrings = Object.values(prim.shadow || {})
    .map(valueOf)
    .filter(Boolean)
  const borderStrings = Object.values(prim.border || {})
    .map(valueOf)
    .filter(Boolean)
  const easingStrings = Object.values(motion.easing || {})
    .map(valueOf)
    .filter(Boolean)

  // Detection helpers
  const accent = accentHex
  const sat = (hex) => {
    const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
    if (!m) return 0
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b)
    if (max === 0) return 0
    return (max - min) / max
  }

  return {
    // Brutalism signature: NON-inset offset shadow whose 3rd value (blur) is 0
    // AND at least one of X/Y offset is ≥3px. We must parse all length tokens
    // from each comma-segment, not regex-grep — figma.com's "0px 24px 70px 0px"
    // (4-value form: X Y blur spread) fooled greedy regexes.
    shadow_zero_blur: shadowStrings.some((s) => {
      // Split multi-layer shadows (commas separate layers, but commas also exist in rgb())
      const segments = s.split(/,(?![^()]*\))/)
      return segments.some((seg) => {
        if (/inset/.test(seg)) return false
        // Pull each "<num>px" token in order — they are X Y blur spread.
        const lens = [...seg.matchAll(/(-?\d+)px/g)].map((m) => parseInt(m[1]))
        if (lens.length < 3) return false
        const [x, y, blur] = lens
        if (blur !== 0) return false
        return Math.abs(x) >= 3 || Math.abs(y) >= 3
      })
    }),
    thick_solid_border: borderStrings.some((s) => /^\s*[3-9]px\s+solid/.test(s)),
    medium_solid_border: borderStrings.some((s) => /^\s*2px\s+solid/.test(s)),
    hairline_border: borderStrings.some((s) => /^\s*1px\s+solid/.test(s)),
    condensed_display: /Anton|Archivo Black|Bebas|Oswald|Space Grotesk/i.test(
      fontFamilies.join(' ')
    ),
    serif_display: /Serif|Fraunces|Spectral|Newsreader|Playfair|Garamond|Times/i.test(
      fontFamilies.join(' ')
    ),
    // Brutalism uses high-saturation accent AND high-sat primary together.
    // Figma's #e4ff97 + #00b6ff are both high-sat but the overall page is calm.
    // So require both colors to be saturated AND warm/clashing for true brutalism.
    high_sat_accent: sat(accent) > 0.7 && sat(primaryHex) > 0.7,
    low_saturation: sat(accent) < 0.5 && sat(primaryHex) < 0.5,
    rotated_transform: false, // hard to detect from tokens alone
    bouncy_easing: easingStrings.some((s) => /back|elastic|bounce/i.test(s)),
    generous_padding: false, // no padding scale exposed in tokens
    minimal_decoration: Object.keys(prim.shadow || {}).length < 2
  }
}

function scorePreset(preset, features) {
  let total = 0,
    maxTotal = 0
  for (const sig of preset.matchSignals) {
    const weight = sig.weight || 0
    maxTotal += weight
    if (features[sig.kind]) total += weight
  }
  return { raw: total, normalized: maxTotal ? total / maxTotal : 0 }
}

// Hybrid score: 0.7 * normalized + 0.3 * raw.
// Pure-raw sort penalises presets that declare few signals (e.g. scatterbrain
// at total weight 0.45 can never beat editorial at 1.00 even with perfect
// hits). Pure-normalised lets a 1-signal preset edge out a 5-signal one by
// matching its only signal. Hybrid: normalised dominates (precision), raw
// breaks ties toward "broadly-aware" presets.
function combinedScore(s) {
  return 0.7 * s.normalized + 0.3 * s.raw
}

function pickPreset() {
  // Always compute features so inference.json can report them, even on --style.
  const features = detectSiteFeatures()
  // Presets with no match_signals fully opt out of auto-inference (no preset
  // currently does this — both prior opt-outs, 8-bit-orbit and liquid-glass,
  // now declare match_signals and gate via requires_capabilities instead).
  const inferablePresets = presets.filter((p) => p.matchSignals.length > 0)
  const scores = inferablePresets.map((p) => {
    const s = scorePreset(p, features)
    const matched = p.matchSignals.filter((sig) => features[sig.kind]).map((sig) => sig.kind)
    const capabilitiesMissing = checkCapabilities(p)
    // Hard rule: any unmet capability zeroes the auto-pick score. The preset
    // still appears in inference.json so the subagent / user can see what would
    // need to be installed to enable it (and auto_install command is surfaced).
    const baseCombined = combinedScore(s)
    const combined = capabilitiesMissing.length > 0 ? 0 : baseCombined
    return {
      name: p.name,
      raw: s.raw,
      normalized: s.normalized,
      combined,
      combined_pre_capability: baseCombined,
      matched,
      capabilities_missing: capabilitiesMissing
    }
  })
  scores.sort((a, b) => b.combined - a.combined)

  if (cliStyle) {
    const forced = presets.find((p) => p.name === cliStyle)
    if (!forced) {
      console.error(
        `✗ unknown --style '${cliStyle}'. available: ${presets.map((p) => p.name).join(', ')}`
      )
      process.exit(1)
    }
    // --style is a deliberate override — the subagent is responsible for having
    // already satisfied the capabilities (e.g. installed the block). We don't
    // re-gate here, but we do surface what's still missing so the agent can act.
    return { preset: forced, mode: 'forced', scores, features }
  }
  if (inferablePresets.length === 0) {
    console.error(`✗ No presets are eligible for auto-inference. Use --style <name>.`)
    process.exit(1)
  }
  const winner = presets.find((p) => p.name === scores[0].name)
  return { preset: winner, mode: 'inferred', scores, features }
}

const { preset, mode, scores, features } = pickPreset()

// ═══════════════════ R2: preset-owned palette fallback ═══
// When the capture yielded NO usable colors (text-only / no-URL path, or a
// fully monochrome site), fall back to the chosen preset's declared palette
// instead of collapsing onto #000000 / palette[0] (which made ink == canvas).
// Extraction, when present, already populated the *Hex vars above — this only
// fires when nothing was scraped, so a real URL capture stays byte-for-byte
// unchanged (no golden-baseline drift). Slots resolve `alias` recursively;
// `lock: "anchor"` values are emitted as-is (§B color-mix() does the tinting).
// Trigger on the RAW captured palette (`hfTokens.colors`), NOT `allColors` —
// the latter synthesizes black/white defaults from empty input, so it's never
// 0. Empty `hfTokens.colors` is the true "nothing scraped" signal; a real URL
// capture always populates it.
if ((hfTokens.colors || []).length === 0 && preset.palette) {
  const _pp = preset.palette
  const _ppGet = (slot, seen = new Set()) => {
    const e = _pp[slot]
    if (!e || seen.has(slot)) return null
    seen.add(slot)
    if (e.alias) return _ppGet(e.alias, seen)
    return e.value ? _normalizeHex(e.value) : null
  }
  primaryHex = _ppGet('primary') || primaryHex
  secondaryHex = _ppGet('secondary') || secondaryHex
  accentHex = _ppGet('accent') || accentHex
  canvasHex = _ppGet('canvas') || canvasHex
  inkHex = _ppGet('ink') || inkHex
  tertiaryHex = _ppGet('tertiary') || tertiaryHex
  costumeHex = _ppGet('costume') || _ppGet('surface') || costumeHex
  signatureGradient = `linear-gradient(135deg, ${primaryHex} 0%, ${secondaryHex} 50%, ${accentHex} 100%)`
}

// ═══════════════════ Font resolution (Google Fonts) ══════
const GFONTS = new Set(
  [
    'Inter',
    'Roboto',
    'Open Sans',
    'Lato',
    'Manrope',
    'Montserrat',
    'Poppins',
    'Work Sans',
    'Plus Jakarta Sans',
    'Outfit',
    'DM Sans',
    'IBM Plex Sans',
    'Karla',
    'Mulish',
    'Rubik',
    'Urbanist',
    'Figtree',
    'Space Grotesk',
    'Source Sans 3',
    'Public Sans',
    'Albert Sans',
    'Geist',
    'Heebo',
    'Barlow',
    'Hind',
    'Nunito',
    'Nunito Sans',
    'Raleway',
    'Cabin',
    'Onest',
    'Instrument Serif',
    'Playfair Display',
    'Merriweather',
    'Lora',
    'EB Garamond',
    'Fraunces',
    'Newsreader',
    'Source Serif 4',
    'PT Serif',
    'Spectral',
    'Crimson Text',
    'JetBrains Mono',
    'Fira Code',
    'IBM Plex Mono',
    'Roboto Mono',
    'Source Code Pro',
    'Space Mono',
    'Geist Mono',
    'DM Mono',
    'Inconsolata',
    'Anton',
    'Archivo Black',
    'Bebas Neue',
    'Alfa Slab One',
    'Archivo Narrow',
    'DM Mono',
    'Caveat Brush',
    'Caveat',
    'Pacifico',
    'Kalam',
    'Sacramento',
    'Permanent Marker',
    'Allura',
    'Cookie',
    'Satisfy',
    'Marck Script'
  ].map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
)

// Final-fallback families if a preset's §D can't be parsed or names nothing on
// Google Fonts. Used when both site DNA and the preset's own §D fall through.
const FINAL_FONT_FALLBACK = {
  display: 'Instrument Serif',
  body: 'Inter',
  mono: 'JetBrains Mono'
}

// ═══════════════════ Local font discovery ════════════════
// Phase 1 (web-research) downloads site-served woff/woff2/otf/ttf into
// research/assets/. If a site font is not on Google Fonts but a matching
// binary exists locally, we self-host it via @font-face so the real brand
// face renders instead of falling back to the preset's §D suggestion.
//
// Heuristic for matching a designlang family name to a downloaded file:
//   - Normalize both sides (lowercase, strip non-alphanum)
//   - File name's leading "<NNN>-" hash prefix and trailing weight/style
//     suffixes (-Regular, -Bold, -Italic, -700, etc.) are stripped before
//     compare. A trailing "-<hex8>" content hash from capture_web_context.py
//     is also stripped.
const FONT_FILE_EXTS = new Set(['.woff2', '.woff', '.otf', '.ttf'])
function normalizeFamily(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}
// designlang sometimes emits a family name that has been mashed together
// without separators (e.g. "GeistVF" → "Geistvf", "DM Serif Display" →
// "Dmserifdisplay"). The local-font filename usually does NOT have those
// axis-suffix letters. Strip a small set of trailing axis tags from a
// normalized key so getComputedStyle('Geistvf') still matches a downloaded
// "Geist-Regular.woff2".
function normalizeFamilyLoose(s) {
  return normalizeFamily(s)
    .replace(/(variablefont|variable|vf)$/i, '')
    .replace(/(wght|opsz|slnt|ital)$/i, '')
}
function splitCamelToWords(s) {
  // "DMSerifDisplay" → "DM Serif Display"; "GeistVF" → "Geist VF"; "Poppins" → "Poppins";
  // "tt_norms_pro_mono" → "TT Norms Pro Mono"; "tt_norms_pro" → "TT Norms Pro".
  //
  // Rules in order:
  //   1. Insert a space between a lower→upper transition ("Geist|VF")
  //   2. Insert a space between two uppers followed by a lower ("DM|Serif")
  //   3. Underscores become spaces (handles "tt_norms_pro" naming common to
  //      bundled woff2 from CMS / foundry distribution packages)
  //   4. Collapse whitespace + trim
  //   5. Title-case each word; words ≤2 chars treated as acronyms (uppercase)
  //
  // Step 5 matters for role-hint matching downstream: /\bmono\b/i needs a
  // word boundary around "mono", which underscores would not provide. After
  // the underscore→space + title-case normalization, "tt_norms_pro_mono"
  // becomes "TT Norms Pro Mono" with proper \b on either side of "Mono".
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}
function fileBaseToFamily(fileName) {
  // Strip extension
  let base = fileName.replace(/\.(woff2?|otf|ttf)$/i, '')
  // Strip leading "NNN-" capture index prefix (capture_web_context.py format)
  base = base.replace(/^\d{3}-/, '')
  // Strip trailing "-<hex 8-10 chars>" content digest (capture_web_context.py
  // adds this to dedupe asset URLs; not part of the family name).
  base = base.replace(/-[0-9a-f]{8,10}$/i, '')
  // Webflow / CMS asset hosts prefix files with a "<24-hex-id>_" resource ID.
  // Example: 657d6bc6bcb648163fa2c02b_Poppins-Regular.woff2. Pull anything
  // up to and including the underscore so we end up with "Poppins-Regular".
  base = base.replace(/^[0-9a-f]{16,32}_/i, '')
  // Same pattern can appear without trailing underscore but with a separating
  // dash — e.g. "657d6bc6bcb648163fa2c02b-Poppins". Less common, but cheap to handle.
  base = base.replace(/^[0-9a-f]{16,32}-/i, '')
  // Strip Google Fonts static-host variable-axis suffix conventions.
  // Examples: "Oswald-VariableFont_wght", "Inter-VariableFont_opsz,wght".
  base = base.replace(/[-_]VariableFont[_,a-zA-Z]*$/i, '')
  // Strip common font-weight/style suffixes. We loop because foundries chain
  // multiple suffixes (e.g. "AnthropicSans-Roman-Web", "Inter-Bold-Italic")
  // and a single pass would leave the inner one behind.
  const SUFFIX_RES = [
    /[-_](Thin|ExtraLight|Light|Normal|Regular|Book|Roman|Upright|Medium|SemiBold|DemiBold|Bold|ExtraBold|Heavy|Black)$/i,
    /[-_](Italic|Oblique)$/i,
    // Web-host variant suffixes — foundries publish "Inter-Web" / "TT_Norms_Pro_Mono_Regular-webfont".
    // The leading anchor [-_] matches either dash or underscore; the alternation
    // covers both single-word and "webfont" composite forms.
    /[-_](Web|Webfont|Desktop|Print|Display|Text)$/i,
    /[-_](100|200|300|400|500|600|700|800|900)$/i,
    /[-_]?VF$/i,
    /[-_]?Variable$/i
  ]
  let prev
  do {
    prev = base
    for (const re of SUFFIX_RES) base = base.replace(re, '')
  } while (base !== prev)
  return base
}
// Looks like a content-hash family name? Next.js (and other build systems)
// sometimes ship raw hashed identifiers as @font-face family — we want to
// keep them out of the discovery map so designlang's "flecha" lookup
// doesn't accidentally bind to "1eff5a6cf292d683".
function looksLikeContentHash(name) {
  const s = String(name || '').trim()
  if (!s) return true
  // Strict: at least 8 consecutive hex characters anywhere in the name.
  if (/[0-9a-f]{8,}/i.test(s)) return true
  // Whole string is dominated by hex / dot / dash separators.
  if (/^[0-9a-f.\-_]+$/i.test(s) && /[0-9a-f]{6,}/i.test(s)) return true
  return false
}
// Some build tools wrap the source family in markers like "__flecha_a1b2c3"
// (Next.js next/font) or "flecha Fallback" (Next.js size-adjust). Recover
// the source family name from these decorations so the lookup hits the
// intended brand identity.
function unwrapBundlerFamily(name) {
  return String(name || '')
    .replace(/^__/, '')
    .replace(/\s+Fallback$/i, '')
    .replace(/_Fallback_/i, '_')
    .replace(/_[a-f0-9]{4,}$/i, '')
    .trim()
}
function discoverLocalFonts(fontsRootDir) {
  // Returns Map<normalized-family, { family: <display-cased>, files: [abs-path...] }>.
  // Each font is indexed under BOTH its strict normalized key and its loose
  // key (axis suffixes stripped), so lookups by either form hit the same entry.
  //
  // Two discovery passes:
  //   1. PRIMARY — read fonts-manifest.json (hyperframes capture's OpenType
  //      `name`-table extraction). Each record carries the authoritative
  //      `family` field read straight from the binary font file, which
  //      handles hashed bundler-emitted filenames (Next.js `_<hex>`).
  //   2. FALLBACK — file-name based discovery for any font files that the
  //      manifest didn't cover.
  const found = new Map()
  if (!fs.existsSync(fontsRootDir)) return found

  function addEntry(familyDisplay, abs) {
    const norm = normalizeFamily(familyDisplay)
    if (!norm) return false
    if (!found.has(norm)) {
      found.set(norm, { family: familyDisplay, files: [] })
    }
    const entry = found.get(norm)
    if (!entry.files.includes(abs)) entry.files.push(abs)
    const looseNorm = normalizeFamilyLoose(familyDisplay)
    if (looseNorm && looseNorm !== norm && !found.has(looseNorm)) {
      found.set(looseNorm, entry)
    }
    return true
  }

  // 1. PRIMARY — fonts-manifest.json from hyperframes capture. The manifest
  //    sits alongside the capture's `extracted/` dir; if we received the
  //    direct fonts dir (e.g. <outDir>/fonts/) we look for a manifest next
  //    to it via ../extracted/fonts-manifest.json, otherwise we look in the
  //    fontsRootDir itself.
  const claimed = new Set()
  const manifestCands = [
    path.join(fontsRootDir, 'fonts-manifest.json'),
    path.resolve(fontsRootDir, '..', 'extracted', 'fonts-manifest.json')
  ]
  for (const manifestPath of manifestCands) {
    if (!fs.existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const files = Array.isArray(manifest.files) ? manifest.files : []
      for (const rec of files) {
        if (!rec || !rec.identified || !rec.family || !rec.file) continue
        const ext = path.extname(rec.file).toLowerCase()
        if (!FONT_FILE_EXTS.has(ext)) continue
        // Resolve against fontsRootDir (where the actual woff files live).
        const abs = path.resolve(fontsRootDir, rec.file)
        if (!fs.existsSync(abs)) continue
        const unwrapped = unwrapBundlerFamily(rec.family)
        if (!unwrapped || looksLikeContentHash(unwrapped)) continue
        const familyDisplay =
          unwrapped.length <= 4
            ? unwrapped.toUpperCase()
            : unwrapped.replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
        if (addEntry(familyDisplay, abs)) claimed.add(path.basename(abs))
      }
      break // first manifest wins
    } catch {
      // Silently fall through to file-name discovery on parse errors.
    }
  }

  // 2. FALLBACK — file-name based discovery for files we didn't already
  //    bind via the manifest. Reject hash-dominated names so Next.js-style
  //    files like "1eff5a6cf292d683-s.p" don't pollute the map.
  for (const ent of fs.readdirSync(fontsRootDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue
    if (claimed.has(ent.name)) continue
    const ext = path.extname(ent.name).toLowerCase()
    if (!FONT_FILE_EXTS.has(ext)) continue
    const familyRaw = fileBaseToFamily(ent.name)
    if (looksLikeContentHash(familyRaw)) continue
    const familyDisplay = splitCamelToWords(familyRaw)
    if (looksLikeContentHash(familyDisplay)) continue
    const abs = path.join(fontsRootDir, ent.name)
    addEntry(familyDisplay, abs)
  }
  return found
}
// Two discovery roots, merged:
//   1. <captureDir>/assets/fonts/ — hyperframes capture's downloaded woff/otf
//      files; the sibling extracted/fonts-manifest.json carries OpenType
//      `name`-table family attribution.
//   2. <outDir>/fonts/ — user-supplied / hand-placed font files when capture
//      misses a site's bundler-hashed font. Filename-discovery only.
// Merge order: capture wins on key collision; user drops fill in gaps.
const captureFontsDir = path.join(captureDir, 'assets', 'fonts')
const userFontsDir = path.join(outDir, 'fonts')
const localFonts = (() => {
  const primary = discoverLocalFonts(captureFontsDir)
  if (!fs.existsSync(userFontsDir)) return primary
  const userDrops = discoverLocalFonts(userFontsDir)
  for (const [key, entry] of userDrops) {
    if (!primary.has(key)) primary.set(key, entry)
  }
  return primary
})()

// Pick the first Google-Fonts-available name from a preset's §D bullet for one
// role. Bullet format (per README §D): `- **<role>**: \`'Name1'\` · \`'Name2'\` · ...`
function parsePresetFontFallback(presetSections) {
  const dContent = presetSections.D?.content || ''
  // script is the 4th role (peoples-platform's Caveat Brush, etc.) — optional;
  // a §D without a script bullet leaves it null and downstream skips emission.
  const roles = { display: null, body: null, mono: null, script: null }
  for (const role of Object.keys(roles)) {
    // Match the bullet line for this role; capture everything after the colon.
    const lineRe = new RegExp(`^\\s*-\\s*\\*\\*${role}\\*\\*\\s*:\\s*(.+)$`, 'mi')
    const lineMatch = dContent.match(lineRe)
    if (!lineMatch) continue
    // Extract each backtick-wrapped name; quotes inside are optional.
    const names = [...lineMatch[1].matchAll(/`['"]?([^'"`]+?)['"]?`/g)].map((m) => m[1].trim())
    // Pick the first name that's on Google Fonts.
    const pick = names.find((n) => GFONTS.has(n.toLowerCase().replace(/[^a-z0-9]/g, '')))
    if (pick) roles[role] = pick
  }
  return roles
}

function resolveFont(siteName, role, presetFontFallback) {
  const norm = normalizeFamily(siteName)
  const looseNorm = normalizeFamilyLoose(siteName)
  // 1. Site family is a known Google Font → load from fonts.googleapis.com
  if (norm && GFONTS.has(norm)) {
    return { name: siteCanonicalName(siteName), source: 'site' }
  }
  // 2. Site family has a matching woff/woff2 in research/assets/ → self-host.
  // Try strict normalized key first, then the loose key (which lets
  // designlang's "Geistvf" match a downloaded "Geist-Regular.woff2"). The
  // canonical display name comes from the discovered file's parsed family,
  // not designlang's mashed string — so "Geistvf" renders as "Geist".
  const localHit = (norm && localFonts.get(norm)) || (looseNorm && localFonts.get(looseNorm))
  if (localHit) {
    return {
      name: localHit.family,
      source: 'site-local',
      localFiles: localHit.files
    }
  }
  // 3. Role-hint fallback against the discovered local-font pool.
  //
  //    Triggers when steps 1+2 fail. Two common cases this rescues:
  //    (a) site didn't name a family for this role at all (empty siteName) —
  //        e.g. Brex's "Space Mono" used only in tiny labels designlang
  //        didn't surface as the mono family; the local @font-face capture
  //        still has the file, role-hint matches it by name "Space Mono".
  //    (b) site DID name a family but it's an unresolvable bundler-hashed
  //        identifier (Next.js `flecha_<hex>`, Webpack content-hash names) —
  //        designlang reports siteName="flecha" which doesn't match any
  //        Google Font and doesn't match a local file by normalized key,
  //        but the underlying file (e.g. "ABCSolarDisplay-Bold.woff2")
  //        has a role-suggesting family name. Role-hint matches it.
  //
  //    Previously this block was gated by `if (!siteName)` — only case (a)
  //    was covered, so HeyGen's `flecha` → display role kept falling
  //    through to preset fallback even when the real font was sitting in
  //    the fonts/ dir. The gate is removed.
  const ROLE_HINTS = {
    mono: /\b(mono|code)\b/i,
    display: /\b(serif|display|headline)\b/i,
    body: null, // body has no reliable name hint
    script: /\b(caveat|brush|script|cursive|kalam|pacifico|sacramento)\b/i
  }
  const hint = ROLE_HINTS[role]
  if (hint) {
    for (const entry of new Set(localFonts.values())) {
      if (hint.test(entry.family)) {
        return {
          name: entry.family,
          source: 'site-local',
          localFiles: entry.files,
          roleHintMatch: true,
          originalName: siteName || null
        }
      }
    }
  }
  // 4. Preset §D bullet → first Google-Fonts-available name
  // 5. Final hard-coded fallback
  const fallback = presetFontFallback[role] || FINAL_FONT_FALLBACK[role]
  return { name: fallback, source: 'preset', originalName: siteName }
}
function siteCanonicalName(s) {
  // Title-case each word, keep canonical names like "JetBrains Mono" intact
  return String(s)
    .split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

// designlang sometimes ships only one family; split display/body/mono heuristically.
// Heuristic: first non-mono family is body, second/mono-named is the alternate.
// If the site has NO mono family, leave rawMono empty so resolveFont() routes
// to the preset fallback path (which honestly reports "preset fallback" in the
// type-roles card) instead of pretending "JetBrains Mono" came from the site.
const monoFromList = fontFamilies.find((f) => /mono|code/i.test(f))
// Script families are rarely emitted by designlang as the primary site family;
// usually only show up when a brand uses a brush face for accent words. Match
// loosely against known display-script names so site-supplied "Caveat Brush"
// gets routed to the script role instead of stealing display.
const SCRIPT_FAMILY_RE =
  /\b(caveat|brush|script|cursive|kalam|pacifico|sacramento|allura|cookie|satisfy|marck|permanent\s*marker)\b/i
const scriptFromList = fontFamilies.find((f) => SCRIPT_FAMILY_RE.test(f))
const nonMono = fontFamilies.filter((f) => !/mono|code/i.test(f) && !SCRIPT_FAMILY_RE.test(f))
const rawDisplay = nonMono[1] || nonMono[0] || ''
const rawBody = nonMono[0] || ''
const rawMono = monoFromList || ''
const rawScript = scriptFromList || ''

const presetFontFallback = parsePresetFontFallback(preset.sections)
const display = resolveFont(rawDisplay, 'display', presetFontFallback)
const body = resolveFont(rawBody, 'body', presetFontFallback)
const mono = resolveFont(rawMono, 'mono', presetFontFallback)
// Script is only resolved when either the site shipped one OR the preset
// declared §D bullet. resolveFont returns a "preset" role when the bullet
// resolves; we treat a null-name result (no site name AND no preset bullet)
// as "this preset doesn't use a script role" and skip @font-face / :root emission.
const script =
  rawScript || presetFontFallback.script
    ? resolveFont(rawScript, 'script', presetFontFallback)
    : null

function gfontsUrl() {
  // Only Google-Fonts and preset-fallback families go through fonts.googleapis.
  // site-local families are loaded via the @font-face block built below.
  const allRoles = script ? [display, body, mono, script] : [display, body, mono]
  const remoteRoles = allRoles.filter((r) => r.source !== 'site-local')
  if (remoteRoles.length === 0) return null
  const fams = []
  const seen = new Set()
  for (const role of remoteRoles) {
    const f = role.name
    if (seen.has(f)) continue
    seen.add(f)
    const wts =
      f === mono.name
        ? '400;500'
        : f === display.name
          ? '400;700;800'
          : script && f === script.name
            ? '400' // script faces typically ship a single weight
            : '400;500;600;700'
    fams.push(`family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${wts}`)
  }
  return `https://fonts.googleapis.com/css2?${fams.join('&')}&display=swap`
}

// ═══════════════════ Self-hosted @font-face block ════════
// For each site-local font role, copy its woff/woff2/otf/ttf binaries from
// research/assets/ into <outDir>/fonts/ (where prep.mjs Step 2b expects them),
// then emit one @font-face declaration per file. The block is wrapped in the
// exact comment anchors prep.mjs Step 2c greps for, so the path-rewrite +
// inject-into-index.html flow lights up without any changes downstream.
function buildLocalFontFaceBlock() {
  const allRoles = script ? [display, body, mono, script] : [display, body, mono]
  const localRoles = allRoles.filter((r) => r.source === 'site-local')
  if (localRoles.length === 0) return { block: '', copiedFiles: [] }
  const fontsDestDir = path.join(outDir, 'fonts')
  fs.mkdirSync(fontsDestDir, { recursive: true })
  const copiedFiles = []
  const seenRoles = new Set()
  const faces = []
  for (const role of localRoles) {
    // Deduplicate: if display + body resolve to the same site-local family,
    // emit @font-face declarations once.
    if (seenRoles.has(role.name)) continue
    seenRoles.add(role.name)
    for (const src of role.localFiles) {
      const fileName = path.basename(src)
      const dest = path.join(fontsDestDir, fileName)
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest)
      }
      copiedFiles.push(fileName)
      const ext = path.extname(fileName).toLowerCase().slice(1)
      const formatMap = { woff2: 'woff2', woff: 'woff', otf: 'opentype', ttf: 'truetype' }
      const format = formatMap[ext] || ext
      faces.push(
        `@font-face {\n  font-family: '${role.name}';\n  src: url('fonts/${fileName}') format('${format}');\n  font-display: swap;\n}`
      )
    }
  }
  // The wrapper anchors are NOT cosmetic — prep.mjs:159 greps for this exact
  // comment pair to extract the block and inject it into index.html <head>.
  // Do not rename without updating prep.mjs in lockstep.
  const block = `/* === auto-injected by download-fonts.mjs === */\n${faces.join('\n')}\n/* === end download-fonts.mjs block === */`
  return { block, copiedFiles }
}
const { block: localFontFaceBlock, copiedFiles: copiedFontFiles } = buildLocalFontFaceBlock()

// ═══════════════════ Voice transform demo ════════════════
// Run the preset's voice recipe against a sample brand sentence so the human
// reader can see "Figma's voice rewritten through brutalism". This is rendered
// in §5 as IN→OUT pairs. The recipe text is left raw; we don't actually execute
// it (LLM does that in Phase 2). We just show 2 examples derived from voice.json
// content if available, else fall back to the canned example in the preset.
function pickVoiceSamples() {
  const candidates = []
  if (description) candidates.push(description)
  for (const h of sampleHeadings) if (h && h.length > 10) candidates.push(h)
  return candidates.slice(0, 2)
}
const voiceSamples = pickVoiceSamples()

// ═══════════════════ HTML escape ═════════════════════════
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}
function mdInlineToHtml(md) {
  // Very small: code spans, **bold**, *italic*. Used only on preset prose.
  return esc(md)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

// Block-level markdown for preset prose (§A intent, §G recipe, §H hints, …).
// Replaces the old `mdInlineToHtml(text).replace(/\n/g,'<br>')` pattern which
// collapsed bullet lists and tables into walls of text. Handles, in priority
// order per block (blocks split by blank line):
//   1. Heading: `## title` / `### title` / `#### title` → <h2>/<h3>/<h4>
//   2. Pipe-table with `|---|` separator row → <table class="ds-table">
//   3. Bullet list (`- foo` / `* foo`) → <ul><li>
//   4. Numbered list (`1. foo`) → <ol><li>
//   5. Fenced code (` ```lang ... ``` `) → <pre><code> (esc'd)
//   6. Anything else → <p class="ds-prose"> with single \n → <br>
// Inline markdown (**bold**, *em*, `code`) still runs via mdInlineToHtml inside.
// Designed for short / well-formed preset prose, not arbitrary user markdown —
// nested lists, blockquotes, link syntax not supported. Add as needed.
function mdBlockToHtml(md) {
  if (!md) return ''
  const blocks = md.replace(/\r\n/g, '\n').split(/\n\s*\n/)
  const out = []
  for (const raw of blocks) {
    const block = raw.replace(/\n+$/, '').replace(/^\n+/, '')
    if (!block.trim()) continue

    // Heading
    const headingMatch = block.match(/^(#{2,4})\s+(.+)$/)
    if (headingMatch && !block.includes('\n')) {
      const lvl = headingMatch[1].length
      out.push(`<h${lvl} class="ds-h${lvl}">${mdInlineToHtml(headingMatch[2])}</h${lvl}>`)
      continue
    }

    // Pipe table — must have ≥2 lines and a separator row of pipes+dashes
    if (/^\s*\|/m.test(block) && /\n\s*\|[\s\-:|]+\|/.test(block)) {
      const lines = block.split('\n').filter((l) => /^\s*\|/.test(l))
      if (lines.length >= 2) {
        const splitCells = (line) =>
          line
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => c.trim())
        const header = splitCells(lines[0])
        const rows = lines.slice(2).map(splitCells)
        const thead = `<thead><tr>${header.map((c) => `<th>${mdInlineToHtml(c)}</th>`).join('')}</tr></thead>`
        const tbody = `<tbody>${rows
          .map((row) => `<tr>${row.map((c) => `<td>${mdInlineToHtml(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody>`
        out.push(`<table class="ds-table">${thead}${tbody}</table>`)
        continue
      }
    }

    // Bullet list — every non-empty line in the block must start with - or *
    if (
      /^\s*[-*]\s/.test(block) &&
      block.split('\n').every((l) => !l.trim() || /^\s*[-*]\s/.test(l))
    ) {
      const items = block
        .split(/\n(?=\s*[-*]\s)/)
        .map((line) =>
          line
            .replace(/^\s*[-*]\s+/, '')
            .replace(/\n\s+/g, ' ')
            .trim()
        )
        .filter(Boolean)
        .map((line) => `<li>${mdInlineToHtml(line)}</li>`)
      out.push(`<ul class="ds-list">${items.join('')}</ul>`)
      continue
    }

    // Numbered list — every non-empty line in the block must start with `\d+. `
    if (
      /^\s*\d+\.\s/.test(block) &&
      block.split('\n').every((l) => !l.trim() || /^\s*\d+\.\s/.test(l))
    ) {
      const items = block
        .split(/\n(?=\s*\d+\.\s)/)
        .map((line) =>
          line
            .replace(/^\s*\d+\.\s+/, '')
            .replace(/\n\s+/g, ' ')
            .trim()
        )
        .filter(Boolean)
        .map((line) => `<li>${mdInlineToHtml(line)}</li>`)
      out.push(`<ol class="ds-list">${items.join('')}</ol>`)
      continue
    }

    // Fenced code block
    const codeMatch = block.match(/^```(\w*)\n([\s\S]+?)\n```$/)
    if (codeMatch) {
      out.push(`<pre class="ds-code"><code>${esc(codeMatch[2])}</code></pre>`)
      continue
    }

    // Default paragraph — inline md + soft line breaks
    out.push(`<p class="ds-prose">${mdInlineToHtml(block).replace(/\n/g, '<br>')}</p>`)
  }
  return out.join('\n')
}

// ═══════════════════ Render: §0 Title card ═══════════════
function renderTitleCard() {
  return `
<section class="title-card">
  <div class="title-card-inner">
    <div class="brand-row">
      <span class="brand-name">${esc(brandName)}</span>
      <span class="brand-x">×</span>
      <span class="style-name">${esc(preset.label)}</span>
    </div>
    <h1 class="title-display">${esc(brandName)}</h1>
    <p class="title-meta">
      <strong>Source</strong> ${esc(sourceUrl) || '—'}
      &nbsp;·&nbsp;
      <strong>Material</strong> ${esc(materialLabel)}
      &nbsp;·&nbsp;
      <strong>Intent</strong> ${esc(intentLabel)}
      &nbsp;·&nbsp;
      <strong>Style</strong> ${esc(preset.label)} ${mode === 'forced' ? '(forced)' : '(auto-inferred)'}
    </p>
  </div>
</section>`
}

// ═══════════════════ Render: §1 Brand DNA ════════════════
function renderBrandDNA() {
  const swatch = (label, hex, extraStyle = '') => `
    <div class="dna-swatch" style="background: ${hex}; color: ${isLight(hex) ? '#000' : '#fff'}; ${extraStyle}">
      <div class="dna-label">${label}</div>
      <div class="dna-hex">${hex}</div>
    </div>`
  return `
<section id="brand-dna" class="ds-section">
  <div class="eyebrow">§1 · Brand DNA (from site)</div>
  <h2>${esc(brandName)} in one glance</h2>
  <div class="dna-grid dna-grid-5">
    ${swatch('Primary', primaryHex)}
    ${swatch('Secondary', secondaryHex)}
    ${swatch('Accent', accentHex)}
    ${swatch('Canvas', canvasHex, 'border: 1px solid #eee;')}
    ${swatch('Ink', inkHex)}
  </div>

  <div class="dna-gradient">
    <div class="dna-gradient-label">Signature gradient</div>
    <div class="dna-gradient-bar" style="background: ${signatureGradient};"></div>
    <code class="dna-gradient-code">${esc(signatureGradient)}</code>
  </div>

  ${description ? `<p class="dna-desc">${esc(description)}</p>` : ''}
</section>`
}

// ═══════════════════ Render: §2 Color × Style ════════════
// §2's :root token body, captured for the §C caption-skin preview iframe (a separate
// document that can't inherit design.html's live :root). Set by renderColorAndTokens();
// read by renderCaptions() — the assembly calls captions after color, so it is populated.
let _captionTokensRoot = ''

function renderColorAndTokens() {
  const decorationTokens = preset.sections.B?.content || ''
  // Extract CSS variable declarations. A declaration starts with a line whose
  // first non-whitespace tokens are `--`, and continues across lines until
  // every opening paren has been closed AND a `;` terminator is seen.
  //
  // This supports multi-line values like:
  //
  //   --grain-image: radial-gradient(
  //     rgba(0,0,0,0.04) 1px,
  //     transparent 1px
  //   );
  //
  // Stray non-declaration lines (`}`, comments, blanks, the opening `:root {`
  // brace, fenced ```css markers) are skipped between declarations.
  const tokenLines = []
  const rawLines = decorationTokens.split('\n')
  let i = 0
  while (i < rawLines.length) {
    const line = rawLines[i]
    if (!/^\s*--/.test(line)) {
      i++
      continue
    }
    // Start of a declaration. Accumulate until paren depth is 0 and line ends with `;`.
    const buffer = [line]
    let depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length
    let terminated = depth === 0 && /;\s*(\/\*.*\*\/)?\s*$/.test(line)
    while (!terminated && i + 1 < rawLines.length) {
      i++
      const cont = rawLines[i]
      buffer.push(cont)
      depth += (cont.match(/\(/g) || []).length - (cont.match(/\)/g) || []).length
      if (depth === 0 && /;\s*(\/\*.*\*\/)?\s*$/.test(cont)) {
        terminated = true
      }
    }
    // Re-emit the declaration with the original indentation of subsequent lines
    // (preserve formatting; the renderColorAndTokens output later re-indents the
    // first line uniformly with "  " — keep continuation lines untouched).
    const first = buffer[0].trim()
    const rest = buffer.slice(1)
    tokenLines.push(rest.length ? first + '\n' + rest.join('\n') : first)
    i++
  }
  // Font role tokens. The unquoted name lets components reference `var(--font-display)`
  // and CSS will look up the @font-face declaration in <head>. The fallback chain
  // covers (a) Google Fonts hadn't finished loading, (b) self-hosted woff failed.
  // serif vs sans-serif vs monospace are chosen per role; the role's resolved
  // name lives in `display.name` / `body.name` / `mono.name`.
  const fontDisplayStack = `'${display.name}', ${preset.name === 'neo-brutalism' || /Mono/i.test(display.name) ? 'ui-monospace, monospace' : /Serif|Playfair|Lora|Garamond|Fraunces|Newsreader|Spectral|Times/i.test(display.name) ? 'Georgia, serif' : 'system-ui, sans-serif'}`
  const fontBodyStack = `'${body.name}', -apple-system, BlinkMacSystemFont, system-ui, sans-serif`
  const fontMonoStack = `'${mono.name}', ui-monospace, SFMono-Regular, Menlo, monospace`
  // Script stack only built when script role resolved (else fontScriptLine below skips emission).
  const fontScriptStack = script ? `'${script.name}', cursive` : ''
  // Script font role is optional — only emitted when preset declares a §D script bullet
  // OR when site exposes a script family. 3-role presets get a no-op blank line.
  const fontScriptLine = script?.name ? `  --font-script:     ${fontScriptStack};\n` : ''
  const rootBody = `
  --brand-primary:   ${primaryHex};
  --brand-secondary: ${secondaryHex};
  --brand-tertiary:  ${tertiaryHex};
  --brand-accent:    ${accentHex};
  --brand-costume:   ${costumeHex};
  --ink:             ${inkHex};
  --canvas:          ${canvasHex};
  --brand-gradient:  ${signatureGradient};
  --deco-1:          ${decoColors[0]};
  --deco-2:          ${decoColors[1]};
  --deco-3:          ${decoColors[2]};
  --deco-4:          ${decoColors[3]};
  --font-display:    ${fontDisplayStack};
  --font-body:       ${fontBodyStack};
  --font-mono:       ${fontMonoStack};
${fontScriptLine}${tokenLines.map((l) => '  ' + l).join('\n')}`
  _captionTokensRoot = rootBody
  return `
<section id="color-tokens" class="ds-section">
  <div class="eyebrow">§2 · Color × Style overlay</div>
  <h2>Color tokens + ${esc(preset.label)} decoration vars</h2>
  <p class="ds-prose">Brand colors come from the site. Decoration variables come from the <strong>${esc(preset.label)}</strong> preset. The <code>:root</code> block is live on this page (so §6 component previews render properly). The paste-ready source for <code>chunks/tokens.css</code> is collapsed below — open it to copy.</p>
  <style>:root {${rootBody}
  }</style>
  <details class="ds-paste-ready">
    <summary class="ds-summary">▸ Paste-ready source → <code>chunks/tokens.css</code></summary>
    <pre class="ds-code"><!-- ROOT-START -->:root {${rootBody}
}<!-- ROOT-END --></pre>
  </details>
</section>`
}

// ═══════════════════ Render: §3 Typography ═══════════════
// Parse §T type-roles JSON block. Each entry is a named text role the Phase 4b
// scene worker may cite by `id` ("use a stamp-statement here") to pick correct
// size / weight / leading / tracking / case + decoration. The atlas renders in
// brand DNA fonts (var(--font-*) tokens), so the role catalog is preset-declared
// but the actual typeface is whatever the brand ships. Returns [] when no §T.
// ─────────────────── Render: §C Captions (preview) ───────
// Preview-only. When the preset ships its own caption-skin.html (style-presets/<preset>/),
// embed it as a demo-filled, auto-looping iframe so design.html shows the real caption
// skin running. That same file is what emit-chunks copies to chunks/caption-skin.html and
// build-captions-html.mjs fills with the real word timings at Phase 4a.5 — so this preview
// is the actual skin, not a re-implementation (zero drift). Presets without a caption-skin
// emit nothing (uniform with non-captioned presets).
function renderCaptions() {
  const skinPath = path.join(PRESETS_DIR, preset.name, 'caption-skin.html')
  if (!fs.existsSync(skinPath)) return ''
  let skin = fs.readFileSync(skinPath, 'utf8')

  // Demo fills — the same holes build-captions-html.mjs fills, with placeholder words +
  // a short looping duration (plain replaces; preview-only, not the strict builder).
  const demoGroups = [
    {
      start: 0.3,
      end: 2.1,
      words: [
        { text: 'WRITE', start: 0.3, end: 0.9 },
        { text: 'HTML,', start: 0.9, end: 1.4 },
        { text: 'RENDER', start: 1.4, end: 2.1 }
      ]
    },
    {
      start: 2.5,
      end: 4.3,
      words: [
        { text: 'VIDEO.', start: 2.5, end: 3.1 },
        { text: 'NO', start: 3.1, end: 3.5 },
        { text: 'TIMELINE.', start: 3.5, end: 4.3 }
      ]
    },
    {
      start: 4.7,
      end: 6.2,
      words: [
        { text: 'JUST', start: 4.7, end: 5.1 },
        { text: 'CODE.', start: 5.1, end: 5.9 }
      ]
    }
  ]
  const demoDur = 6.6
  skin = skin.replace('var GROUPS = [];', `var GROUPS = ${JSON.stringify(demoGroups)};`)
  skin = skin.replace('var DURATION = 0;', `var DURATION = ${demoDur};`)
  skin = skin.replace('data-duration="0"', `data-duration="${demoDur}"`)
  // Inject @font-face + :root tokens. The iframe is a separate document, so it can't
  // inherit design.html's <head> fonts/tokens; the @font-face url('fonts/…') paths are
  // relative and resolve against design.html's own dir (which has fonts/), so the preview
  // renders in the real brand display face, not a system fallback.
  skin = skin.replace(
    '<style data-brand-tokens></style>',
    `<style data-brand-tokens>\n${localFontFaceBlock}\n:root {${_captionTokensRoot}\n}</style>`
  )
  // The skin registers a PAUSED timeline (engine drives it at render time). For the doc
  // preview, grab it and loop it.
  skin = skin.replace(
    '</body>',
    `  <script>
    (function () {
      var t = window.__timelines && window.__timelines["captions"];
      if (t && t.duration()) t.repeat(-1).repeatDelay(0.5).play();
    })();
  </script>
</body>`
  )

  // Fully HTML-escape for the srcdoc attribute (the browser decodes it back into the
  // iframe document). Escape & first, then angle brackets and the quote delimiter.
  const srcdoc = skin
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return `
<section id="captions" class="ds-section">
  <div class="eyebrow">§C · Captions (preset-local skin)</div>
  <h2>Word <em>by word.</em></h2>
  <p class="ds-prose">Live preview of <code>caption-skin.html</code> — this preset's own caption look. The same file is copied to <code>chunks/caption-skin.html</code> and filled with real word timings by the caption builder (Phase 4a.5); the demo words and loop here are preview-only.</p>
  <div style="position: relative; width: 100%; max-width: 960px; aspect-ratio: 16 / 9; overflow: hidden; border: 1px solid #e5e5e5; border-radius: 8px; margin: 24px 0; background: #fff;">
    <iframe title="caption-skin preview" loading="lazy" style="position: absolute; top: 0; left: 0; width: 1920px; height: 1080px; border: 0; transform: scale(0.5); transform-origin: top left;" srcdoc="${srcdoc}"></iframe>
  </div>
</section>`
}

function parseTypeRoles() {
  const sect = preset.sections?.T?.content
  if (!sect) return []
  const fenced = sect.match(/```type-roles\n([\s\S]+?)\n```/)
  if (!fenced) return []
  try {
    const arr = JSON.parse(fenced[1])
    return Array.isArray(arr) ? arr : []
  } catch (e) {
    console.error(`✗ ${preset.name}: §T type-roles JSON failed to parse — ${e.message}`)
    return []
  }
}

// Pull every `.t-trole-<roleId>` CSS rule out of §I page-level CSS so the
// paste-ready chunks/type-roles.md ships decoration (color, shadow, transform,
// pseudo descendants) alongside the role's metadata. Matches plain selectors,
// descendant pseudo (`.t-trole-foo em`), compound classes (`.t-trole-foo.x`),
// and chained children (`.t-trole-foo .bar`). Uses a permissive `{…}` body
// matcher — these blocks are hand-authored CSS with no nesting.
function extractRoleCss(roleId, sectionICss) {
  if (!sectionICss) return ''
  const re = new RegExp(`\\.t-trole-${roleId}(?![a-zA-Z0-9_-])[^{}]*\\{[^}]*\\}`, 'g')
  return [...sectionICss.matchAll(re)].map((m) => m[0].trim()).join('\n\n')
}

// Build chunks/type-roles.md content. One section per role: metadata header +
// CSS rule (from §I) + sample HTML. Returns "" when preset declares no §T —
// emit-chunks will then leave type-roles.md unwritten and index.json's
// type_roles_file = null.
function buildTypeRolesMd() {
  const roles = parseTypeRoles()
  if (!roles.length) return ''
  const sectionICss = [...(preset.sections.I?.content || '').matchAll(/```css\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join('\n')
  const sections = roles.map((r) => {
    const css = extractRoleCss(r.id, sectionICss)
    const sample = String(r.sample_html || '').trim()
    return `## type-role: ${r.id}

- family: ${r.family || '—'} · px: ${r.px_min ?? '—'}–${r.px_max ?? '—'} · weight: ${r.weight ?? '—'}
- leading: ${r.leading ?? '—'} · tracking: ${r.tracking ?? '—'} · case: ${r.case || '—'}
- purpose: ${r.purpose || '—'}

\`\`\`css
${css || `/* (preset §I did not ship CSS for .t-trole-${r.id} — derive from metadata above) */`}
\`\`\`

Sample:

\`\`\`html
${sample}
\`\`\``
  })
  return `# Type-roles atlas — ${preset.label}

Phase 4b scene worker reads this when text outside §6 components is needed (hero displays, ledes, pill rows, CTA buttons, …). Workflow: pick role by id → paste the CSS rule into scene \`<style>\` with \`s<N>-\` prefix on the class names → wrap content using the prefixed class. Family tokens (\`var(--font-*)\`) resolve to brand DNA at scene-render time.

${sections.join('\n\n')}`
}

function renderTypography() {
  const recipe = preset.sections.D?.content || ''
  const typeRoles = parseTypeRoles()
  const atlasBlock = typeRoles.length
    ? `
  <h3 class="ds-h3" style="margin-top: 48px;">Type-role atlas</h3>
  <div class="ds-trole-box">
    ${typeRoles
      .map((r) => {
        const sample = String(r.sample_html || '').replace(/\{(\w+)\}/g, (_, k) =>
          placeholderFor(k)
        )
        // Meta (id / family / px / weight / leading / tracking / case / purpose) is
        // kept in data-* attrs — machine-readable for the plan agent, invisible to
        // the reviewer. The rendered row is just the sample, so design.html shows
        // what text actually looks like at scene scale, not a spec sheet.
        const dataAttrs = [
          `data-scale="${esc(r.id || '')}"`,
          `data-family="${esc(r.family || '')}"`,
          `data-px-min="${esc(String(r.px_min ?? ''))}"`,
          `data-px-max="${esc(String(r.px_max ?? ''))}"`,
          `data-weight="${esc(String(r.weight ?? ''))}"`,
          `data-leading="${esc(String(r.leading ?? ''))}"`,
          `data-tracking="${esc(String(r.tracking ?? ''))}"`,
          `data-case="${esc(r.case || '')}"`,
          `data-purpose="${esc(r.purpose || '')}"`
        ].join(' ')
        return `
    <div class="ds-trole-row" ${dataAttrs}>
      <div class="ds-trole-sample">${sample}</div>
    </div>`
      })
      .join('')}
  </div>`
    : ''
  return `
<section id="typography" class="ds-section">
  <div class="eyebrow">§3 · Typography</div>
  <h2>Type roles</h2>
  <p class="ds-prose">Font families resolved by 4-step lookup: site name on Google Fonts → self-host local woff2 → preset §D fallback → final hard-coded fallback. Each card shows which step landed.</p>

  <div class="type-grid">
    ${[
      [
        'Display',
        display,
        'serif',
        `font-size: 72px; font-weight: ${preset.name === 'neo-brutalism' ? 800 : 400}; letter-spacing: ${preset.name === 'neo-brutalism' ? '-0.04em' : '-0.02em'}; line-height: 1;`,
        brandName
      ],
      [
        'Body',
        body,
        'sans-serif',
        'font-size: 22px; line-height: 1.5;',
        'The quick brown fox jumps over the lazy dog.'
      ],
      ['Mono', mono, 'ui-monospace, monospace', 'font-size: 18px;', `font: ${mono.name}`],
      ...(script
        ? [
            [
              'Script',
              script,
              'cursive',
              'font-size: 56px; font-weight: 400; line-height: 1; transform: rotate(-3deg); display: inline-block;',
              'gets simpler —'
            ]
          ]
        : [])
    ]
      .map(([roleLabel, role, fallbackChain, specimenStyle, specimenText]) => {
        let note
        if (role.source === 'site') {
          note = `<div class="type-note">✓ from site (Google Fonts CDN)</div>`
        } else if (role.source === 'site-local') {
          const fileCount = role.localFiles.length
          note = `<div class="type-note">✓ from site (self-hosted, ${fileCount} woff/woff2 file${fileCount > 1 ? 's' : ''})</div>`
        } else if (role.originalName) {
          note = `<div class="type-note">site '${esc(role.originalName)}' not resolvable → preset fallback</div>`
        } else {
          note = `<div class="type-note">site has no ${roleLabel.toLowerCase()} face → preset fallback</div>`
        }
        return `
    <div class="type-card">
      <div class="type-role">${roleLabel}</div>
      <div class="type-name">${esc(role.name)}</div>
      ${note}
      <div class="type-specimen" style="font-family: '${esc(role.name)}', ${fallbackChain}; ${specimenStyle}">${esc(specimenText)}</div>
    </div>`
      })
      .join('')}
  </div>
${atlasBlock}
${(() => {
  const typeRolesMd = buildTypeRolesMd()
  if (!typeRolesMd) return ''
  return `
  <details class="ds-paste-ready" style="margin-top: 32px;">
    <summary class="ds-summary">▸ Paste-ready source → <code>chunks/type-roles.md</code> (scene worker reads on demand)</summary>
    <pre class="ds-code"><!-- TYPE-ROLES-START -->
${esc(typeRolesMd)}
<!-- TYPE-ROLES-END --></pre>
  </details>`
})()}
  <details style="margin-top: 32px;">
    <summary class="ds-summary">Font pairing recipe (preset §D)</summary>
    <div class="ds-prose-block">${mdBlockToHtml(recipe)}</div>
  </details>
</section>`
}

// ═══════════════════ Render: §4 Motion ═══════════════════
function renderMotion() {
  const motionContent = preset.sections.E?.content || ''
  const intent = preset.sections.A?.content || ''
  // Pull out the JS block
  const jsMatch = motionContent.match(/```js\n([\s\S]*?)```/)
  const motionJs = jsMatch ? jsMatch[1].trim() : motionContent
  return `
<section id="motion" class="ds-section">
  <div class="eyebrow">§4 · Motion (preset)</div>
  <h2>${esc(preset.label)} motion language</h2>
  <div class="ds-prose-block">${mdBlockToHtml(intent)}</div>
  <details class="ds-paste-ready">
    <summary class="ds-summary">▸ Paste-ready source → <code>chunks/easings.js</code> (paste at top of every scene's <code>&lt;script&gt;</code>)</summary>
    <pre class="ds-code"><!-- MOTION-START -->
${esc(motionJs)}
<!-- MOTION-END --></pre>
  </details>
</section>`
}

// ═══════════════════ Render: §5 Voice ════════════════════
// Two artifacts live in this section:
//   1. Human-readable cards (DNA dl + recipe prose) — for design.html browsers.
//   2. <pre class="ds-code"><!-- VOICE-START --> ... <!-- VOICE-END --></pre>
//      — the paste-ready block that emit-chunks.mjs extracts to chunks/voice.md.
//      Phase 4b scene workers consume this when writing on-screen copy
//      (headlines, chips, buttons) so the brand register hits the DOM text.
//      Narrator scripts (TTS-bound) are NOT in scope — Phase 2 ignores it.
function renderVoice() {
  const recipe = (preset.sections.G?.content || '').trim()
  const dnaLines = [
    voiceTone && `- Tone: ${voiceTone}`,
    voiceHeading && `- Heading style: ${voiceHeading}`,
    sampleHeadings.length &&
      '- Sample headings:\n' + sampleHeadings.map((s) => `  - ${s}`).join('\n')
  ].filter(Boolean)
  const voiceMd = `# Voice register: ${preset.name}

## From the site (DNA)
${dnaLines.join('\n')}

## Transform recipe

${recipe}

> Phase 4b scene workers: apply to DOM text only (headline / chip / button copy).
> Phase 2 narrator scripts are TTS-bound — do NOT uppercase or strip articles.`

  return `
<section id="voice" class="ds-section">
  <div class="eyebrow">§5 · Voice (site × style transform)</div>
  <h2>How to write on-screen copy in ${esc(preset.label)} register</h2>

  <div class="voice-grid">
    <div>
      <h3 class="ds-h3">From the site (DNA)</h3>
      <dl class="voice-dl">
        ${voiceTone ? `<dt>Tone</dt><dd>${esc(voiceTone)}</dd>` : ''}
        ${voiceHeading ? `<dt>Heading style</dt><dd>${esc(voiceHeading)}</dd>` : ''}
        ${voiceCtaVerbs?.length ? `<dt>CTA verbs</dt><dd>${voiceCtaVerbs.map((c) => `<span class="voice-cta">${esc(c)}</span>`).join(' ')}</dd>` : ''}
        ${sampleHeadings.length ? `<dt>Sample headings</dt><dd>${sampleHeadings.map((s) => `<div class="voice-sample">${esc(s)}</div>`).join('')}</dd>` : ''}
      </dl>
    </div>
    <div>
      <h3 class="ds-h3">Transform recipe (preset §G)</h3>
      <div class="ds-prose-block">${mdBlockToHtml(recipe)}</div>
    </div>
  </div>

  ${
    voiceSamples.length
      ? `<h3 class="ds-h3" style="margin-top: 32px;">Try it on this site's voice</h3>
  ${voiceSamples
    .map(
      (s) => `
  <div class="voice-pair">
    <div class="voice-in"><span class="voice-tag">IN (site)</span> ${esc(s)}</div>
    <div class="voice-out"><span class="voice-tag">OUT (Phase 4b applies recipe to DOM copy)</span> <em>worker writes register-shaped HTML text</em></div>
  </div>`
    )
    .join('')}`
      : ''
  }

  <details class="ds-paste-ready" style="margin-top: 32px;">
    <summary class="ds-summary">▸ Paste-ready source → <code>chunks/voice.md</code> (Phase 4b applies recipe to DOM text)</summary>
    <pre class="ds-code"><!-- VOICE-START -->
${esc(voiceMd)}
<!-- VOICE-END --></pre>
  </details>
</section>`
}

// ═══════════════════ Render: §6 Components ═══════════════
// Rewrite hardcoded font-family declarations in preset component CSS into
// var(--font-*) token references. Preset MD files were written with literal
// font names ("Bodoni Moda", "Manrope") as design-time hints — at composition
// time we want them flowing through the brand-resolved tokens (which may be
// site-local woff2, Google Fonts CDN, or preset fallback).
//
// Classification:
//   - Any family list containing a serif name → --font-display (display roles
//     in editorial / capsule / Bodoni-class presets are the prominent serifs)
//   - Any family list containing a mono name → --font-mono
//   - Everything else (sans-serif body fonts: Manrope/Inter/Geist/etc) → --font-body
//
// We rewrite a font-family line as a whole; once stripped down to a token
// reference we drop the original fallback chain (the token itself carries
// system-ui / serif / monospace fallbacks).
// "serif" must not be preceded by "sans-" (the generic family "sans-serif" is
// a sans, not a serif). We test for "serif" only when no "sans-" appears just
// before it. Other serif family names match by literal word.
const SERIF_NAME_RE =
  /(?<!sans-)\bserif\b|\b(Bodoni|Playfair|Garamond|Fraunces|Newsreader|Spectral|Times|Lora|Source Serif|Crimson|Merriweather|PT Serif|DM Serif|Alfa Slab|Archivo Black|Anton|Big Shoulders|Stardos Stencil|Bowlby)\b/i
const MONO_NAME_RE =
  /\b(monospace|JetBrains Mono|Fira Code|IBM Plex Mono|Roboto Mono|Source Code|Space Mono|Geist Mono|DM Mono|Inconsolata|SFMono|Menlo|Consolas|ui-monospace|Barlow Condensed|VT323|Press Start 2P)\b/i
// Script faces (caveat-brush etc.) get routed to var(--font-script). Order
// matters: script check runs BEFORE serif because some script names share
// generic keywords. The 4th role lives next to mono/display/serif.
const SCRIPT_NAME_RE =
  /\b(Caveat|Caveat Brush|Pacifico|Kalam|Allura|Sacramento|Cookie|Satisfy|Marck Script|Permanent Marker)\b/i
function rewriteComponentFontFamilies(block) {
  // Replace each `font-family: <chain>;` with the right token. Skip values
  // that already reference var(--font-*) so re-running is a no-op.
  return block.replace(/font-family:\s*([^;\n}]+);/g, (full, chain) => {
    if (/var\(--font-/.test(chain)) return full
    let token
    if (MONO_NAME_RE.test(chain)) token = 'var(--font-mono)'
    else if (SCRIPT_NAME_RE.test(chain)) token = 'var(--font-script)'
    else if (SERIF_NAME_RE.test(chain)) token = 'var(--font-display)'
    else token = 'var(--font-body)'
    return `font-family: ${token};`
  })
}

// ═══════════════════ Render: §H composition hints ════════
// Two artifacts:
//   1. Human-readable preset rules — for design.html browsers.
//   2. <pre class="ds-code"><!-- HINTS-START --> ... <!-- HINTS-END --></pre>
//      — paste-ready block that emit-chunks.mjs extracts to chunks/composition-hints.md.
//      Phase 3 plan agent consumes this when picking components per scene:
//        - surface contract (which components go on which surface)
//        - material composition rules (single triple-stamp per plate, etc.)
//        - 60/30/10 brand color placement
//      Presets without §H emit an empty block (anchor still present so emit-chunks
//      can produce a stub composition-hints.md the plan agent can read uniformly).
function renderHints() {
  const hintsContent = (preset.sections.H?.content || '').trim()
  // Build the paste-ready md block. Keep the preset's §H content verbatim —
  // it's authored prose, not a structured schema. Plan agent reads it as
  // free-form guidance and applies the constraints when choosing components.
  const hintsMd = hintsContent
    ? `# Composition hints — ${preset.label}\n\n${hintsContent}`
    : `# Composition hints — ${preset.label}\n\n_(preset declared no §H — plan agent picks components by id alone)_`
  return `
<section id="hints" class="ds-section">
  <div class="eyebrow">§H · Scene composition hints (plan agent reads these)</div>
  <h2>${esc(preset.label)} composition rules</h2>
  <p class="ds-prose">Surface contracts, material composition rules, brand-color placement — anything that constrains <strong>which</strong> components a Phase 3 plan can mix in a single scene.</p>
  <div class="ds-prose-block">${mdBlockToHtml(hintsContent || '_no §H declared_')}</div>
  <details class="ds-paste-ready">
    <summary class="ds-summary">▸ Paste-ready source → <code>chunks/composition-hints.md</code> (plan agent reads this)</summary>
    <pre class="ds-code"><!-- HINTS-START -->
${esc(hintsMd)}
<!-- HINTS-END --></pre>
  </details>
</section>`
}

function renderComponents() {
  if (!preset.components.length) return ''
  // When the preset declares chromeFonts, render the live preview inside
  // .preset-native-scope so var(--font-*) resolves to preset-native families
  // (e.g. Alfa Slab) instead of brand DNA. The paste-ready source block under
  // <details> is untouched — Phase 4b still grep + paste the original tokens,
  // and those resolve to brand DNA at scene-render time. The preview is purely
  // a visual reference for what each component looks like at full preset-native
  // expression. No dual-column — reviewers see the north-star directly.
  const presetNative = !!preset.chromeFonts?.googleFontsHref
  const previewClass = presetNative ? 'comp-preview preset-native-scope' : 'comp-preview'
  return `
<section id="components" class="ds-section">
  <div class="eyebrow">§6 · Components (paste-ready)</div>
  <h2>${esc(preset.label)} component library</h2>

  ${preset.components
    .map((rawC) => {
      const c = { ...rawC, block: rewriteComponentFontFamilies(rawC.block) }
      // Live preview = render the HTML inside the component block (it's already a working snippet)
      // For safety we extract first ```html ... ``` and first ```...``` style blocks if present.
      const htmlMatch = c.block.match(/```html\n([\s\S]*?)```/)
      const cssMatch = c.block.match(/```html[\s\S]*?<style>([\s\S]*?)<\/style>/)
      const htmlSnippet = htmlMatch ? htmlMatch[1].trim() : ''
      // Strip <style> from the html before live-rendering — to a fixpoint, so
      // fragments left by one pass can't reassemble into a new <style> block
      // (CodeQL js/incomplete-multi-character-sanitization).
      let htmlForPreview = htmlSnippet
      for (let prev = null; prev !== htmlForPreview; ) {
        prev = htmlForPreview
        htmlForPreview = htmlForPreview.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
      }
      htmlForPreview = htmlForPreview.trim()
      const expanded = htmlForPreview.replace(/\{(\w+)\}/g, (_, key) => placeholderFor(key))
      return `
  <div class="comp-card">
    <div class="comp-head">
      <span class="comp-name">${esc(c.name)}</span>
      <span class="comp-marker">&lt;!-- COMPONENT: ${esc(c.name)} --&gt;</span>
    </div>
    <div class="${previewClass}">
      <style>${cssMatch ? cssMatch[1] : ''}</style>
      ${expanded}
    </div>
    <details>
      <summary class="ds-summary">Source</summary>
      <pre class="ds-code">&lt;!-- COMPONENT: ${esc(c.name)} --&gt;
${c.meta ? `&lt;!-- COMPONENT-META: ${esc(JSON.stringify(c.meta))} --&gt;\n` : ''}${esc(c.block)}
&lt;!-- /COMPONENT --&gt;</pre>
    </details>
  </div>`
    })
    .join('')}
</section>`
}

// Keys whose values are HTML and should NOT be HTML-escaped before injection.
const RAW_HTML_KEYS = new Set(['FOREGROUND_CONTENT', 'HEADLINE_WITH_EM'])
function placeholderFor(key) {
  // Slot fills are seen in design.html previews. Keep them in video register
  // (3-6 words, fragmented sentences) so downstream scene-worker agents don't
  // copy webpage-length paragraphs from the brand DNA capture into 6-second
  // scenes. Long brand text belongs in chunks/voice.md, not in slot previews.
  const map = {
    EYEBROW: 'Build faster',
    HEADLINE: brandName,
    SUBHEAD: 'Stamped. Signed. Framed.',
    LABEL: 'Get started',
    LEDE: 'Two lines max. One idea.',
    KICKER: 'Issue 01',
    NUM: '4M',
    QUOTE: sampleHeadings[0] || 'This changes how teams work.',
    AUTHOR: 'Customer Quote',
    LEFT: 'Column one content',
    RIGHT: 'Column two content',
    HEADLINE_WITH_EM:
      'borders are <em>structural</em>. shadows are <em>weight</em>. tilt is <em>intent</em>.',
    DO_1: 'Use accent on exactly one element per scene',
    DO_2: 'Keep display weight at 800, body at 500',
    DO_3: 'Cut between scenes — never crossfade',
    DONT_1: "Don't add a second accent color",
    DONT_2: "Don't use body text under 24px in video",
    DONT_3: "Don't blur shadows — offset only",
    FOREGROUND_CONTENT: `<div style="font-family: '${display.name}', serif; font-size: clamp(40px, 5vw, 88px); line-height: 1.05; letter-spacing: -0.02em; margin-bottom: 16px;">${brandName}</div><div style="font-family: '${body.name}', sans-serif; font-size: clamp(16px, 1.4vw, 20px); opacity: 0.85; max-width: 38ch;">Stamped. Signed. Framed.</div>`,

    // —— peoples-platform / designhtml-class additions ——
    // Inline script-em pattern (e.g. "The work gets simpler as the team gets braver.")
    SCRIPT_BEFORE: 'The work ',
    SCRIPT_WORD: 'gets simpler',
    SCRIPT_AFTER: ' as the team gets braver.',
    // Stat-block trio (numeral + unit + caption with em + supporting source line)
    STAT_UNIT: '%',
    STAT_SOURCE: `— Internal source, Q1 ${new Date().getFullYear()} —`,
    // Quote attribution sub-roles
    AUTHOR_ROLE: '— Head of Ops, Acme Inc. —',
    // Diamond list (3 priority sentences)
    ITEM_1: 'Ship the core flow. Cut three legacy paths.',
    ITEM_2: 'Talk to ten teams. Brief findings every Friday.',
    ITEM_3: 'One launch, not five. Shared positioning across drops.',
    // Track-dots timeline (4 sequential beats)
    LABEL_1: 'May · Kickoff',
    LABEL_2: 'June · Beta',
    LABEL_3: 'August · Launch',
    LABEL_4: 'October · Scale',
    // Round-stamp content (big mark / small mark / closer caption)
    MARK_BIG: 'END',
    MARK_SMALL: '— V. 01 —',
    CAPTION: 'Stamped, signed, closed.',
    // End-plate credit line
    CREDIT: `★ ${brandName} · Vol. 01 ★`
  }
  const value = map[key] ?? key
  return RAW_HTML_KEYS.has(key) ? value : esc(value)
}

// ═══════════════════ Page styles ═════════════════════════
// Pull preset §I "Page-level CSS" — the styling that should drive design.html
// itself (hero, section borders, dividers, decorations). Falls back gracefully
// if preset doesn't define §I.
function extractPagePresetCss() {
  const raw = preset.sections.I?.content || ''
  // Pull all fenced ```css blocks (a preset may have multiple)
  const blocks = [...raw.matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1])
  if (blocks.length === 0) return ''
  return `\n/* ── Preset §I page styling (from ${esc(preset.name)}.md) ── */\n${blocks.join('\n\n')}`
}

function renderPageStyles() {
  return `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: '${esc(body.name)}', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: ${inkHex};
    background: ${canvasHex};
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 32px; }
  .ds-section { padding: 80px 0; border-top: 1px solid ${isLight(canvasHex) ? '#e5e5e5' : '#222'}; }
  .ds-section:first-of-type { border-top: none; }
  .eyebrow { font-family: '${esc(mono.name)}', ui-monospace, monospace; font-size: 12px; text-transform: uppercase; letter-spacing: 0.14em; opacity: 0.6; margin-bottom: 12px; }
  h1, h2, h3 { font-family: '${esc(display.name)}', serif; font-weight: ${preset.name === 'neo-brutalism' ? 800 : 400}; letter-spacing: ${preset.name === 'neo-brutalism' ? '-0.03em' : '-0.015em'}; line-height: 1.05; }
  h2 { font-size: clamp(36px, 4vw, 56px); margin-bottom: 16px; }
  h3.ds-h3 { font-size: 18px; font-family: '${esc(body.name)}', sans-serif; font-weight: 600; margin: 20px 0 12px; opacity: 0.85; }
  .ds-prose { font-size: 16px; max-width: 62ch; margin: 12px 0; opacity: 0.85; }
  .ds-prose code, code { font-family: '${esc(mono.name)}', monospace; background: ${isLight(canvasHex) ? '#f0f0f0' : '#1a1a1a'}; padding: 2px 6px; border-radius: 3px; font-size: 0.92em; }
  .ds-code { font-family: '${esc(mono.name)}', monospace; background: ${isLight(canvasHex) ? '#0f1419' : '#0a0a0a'}; color: #e6edf3; padding: 20px 24px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.6; margin: 16px 0; white-space: pre; }
  .ds-summary { cursor: pointer; padding: 8px 0; font-family: '${esc(mono.name)}', monospace; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.7; }
  details[open] .ds-summary { opacity: 1; }

  /* Paste-ready source blocks — collapsed by default because the raw markdown / CSS
     in <pre> doesn't render as a readable doc (it's machine-bound for emit-chunks).
     The rendered version sits above each <details>. */
  .ds-paste-ready { margin: 16px 0; padding: 12px 16px; border: 1px dashed ${isLight(canvasHex) ? '#bbb' : '#444'}; border-radius: 8px; background: ${isLight(canvasHex) ? '#fafafa' : '#181818'}; }
  .ds-paste-ready > .ds-summary { padding: 4px 0; font-size: 11px; opacity: 0.85; }
  .ds-paste-ready > .ds-summary code { background: ${isLight(canvasHex) ? '#eee' : '#222'}; padding: 1px 5px; border-radius: 3px; font-size: 0.95em; }
  .ds-paste-ready[open] > .ds-summary { margin-bottom: 8px; }
  .ds-paste-ready > pre.ds-code { margin: 0; }

  /* ── Title card */
  .title-card { padding: 80px 0 64px; border-bottom: 1px solid ${isLight(canvasHex) ? '#e5e5e5' : '#222'}; }
  .title-card-inner { max-width: 1120px; margin: 0 auto; padding: 0 32px; }
  .brand-row { display: flex; gap: 12px; align-items: baseline; font-family: '${esc(mono.name)}', monospace; font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 24px; }
  .brand-name { color: ${primaryHex}; font-weight: 700; }
  .brand-x { opacity: 0.4; }
  .style-name { color: ${accentHex}; font-weight: 700; }
  .title-display { font-size: clamp(48px, 7vw, 96px); margin: 0; }
  .title-meta { margin-top: 32px; font-family: '${esc(mono.name)}', monospace; font-size: 12px; opacity: 0.7; }
  .title-meta strong { font-weight: 700; opacity: 0.9; }

  /* ── §1 Brand DNA */
  .dna-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 24px 0; }
  .dna-grid-5 { grid-template-columns: repeat(5, 1fr); }
  .dna-swatch { padding: 24px 20px; border-radius: 8px; min-height: 120px; display: flex; flex-direction: column; justify-content: space-between; }
  .dna-label { font-family: '${esc(mono.name)}', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; opacity: 0.8; }
  .dna-hex { font-family: '${esc(mono.name)}', monospace; font-size: 18px; font-weight: 700; }
  .dna-desc { margin-top: 24px; font-size: 18px; line-height: 1.55; max-width: 60ch; opacity: 0.85; }
  .dna-gradient { margin: 32px 0 0; }
  .dna-gradient-label { font-family: '${esc(mono.name)}', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; opacity: 0.6; margin-bottom: 10px; }
  .dna-gradient-bar { height: 96px; border-radius: 8px; }
  .dna-gradient-code { display: block; margin-top: 10px; font-family: '${esc(mono.name)}', monospace; font-size: 12px; opacity: 0.7; word-break: break-all; }
  @media (max-width: 900px) { .dna-grid-5 { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 720px) { .dna-grid { grid-template-columns: repeat(2, 1fr); } .dna-grid-5 { grid-template-columns: repeat(2, 1fr); } }

  /* ── §3 Typography */
  .type-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 24px 0; }
  .type-card { padding: 24px; border: 1px solid ${isLight(canvasHex) ? '#e5e5e5' : '#222'}; border-radius: 8px; }
  .type-role { font-family: '${esc(mono.name)}', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; opacity: 0.6; }
  .type-name { font-size: 18px; font-weight: 600; margin: 4px 0; }
  .type-note { font-family: '${esc(mono.name)}', monospace; font-size: 11px; opacity: 0.5; margin-bottom: 16px; }
  .type-specimen { margin-top: 16px; }
  @media (max-width: 720px) { .type-grid { grid-template-columns: 1fr; } }

  /* ── §5 Voice */
  .voice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin: 24px 0; }
  .voice-dl dt { font-family: '${esc(mono.name)}', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; opacity: 0.6; margin-top: 16px; }
  .voice-dl dd { font-size: 15px; margin-top: 4px; }
  .voice-cta { display: inline-block; padding: 2px 10px; border: 1px solid ${isLight(canvasHex) ? '#ddd' : '#333'}; border-radius: 999px; font-size: 13px; margin: 2px 4px 2px 0; }
  .voice-sample { font-size: 15px; opacity: 0.85; margin: 4px 0; }
  .voice-pair { padding: 16px; border: 1px solid ${isLight(canvasHex) ? '#e5e5e5' : '#222'}; border-radius: 8px; margin: 12px 0; }
  .voice-tag { font-family: '${esc(mono.name)}', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; opacity: 0.6; margin-right: 8px; }
  .voice-in { margin-bottom: 8px; }
  .voice-out { opacity: 0.7; }
  @media (max-width: 720px) { .voice-grid { grid-template-columns: 1fr; } }

  /* ── §6 Components */
  .comp-card { padding: 0; border: 1px solid ${isLight(canvasHex) ? '#e5e5e5' : '#222'}; border-radius: 8px; margin: 16px 0; overflow: hidden; }
  .comp-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: ${isLight(canvasHex) ? '#fafafa' : '#181818'}; border-bottom: 1px solid ${isLight(canvasHex) ? '#e5e5e5' : '#222'}; }
  .comp-name { font-family: '${esc(mono.name)}', monospace; font-size: 13px; font-weight: 700; }
  .comp-marker { font-family: '${esc(mono.name)}', monospace; font-size: 11px; opacity: 0.6; }
  /* Component preview: components are authored for 1920×1080 scenes. The doc
     container is ~1056px wide, so wide components (mega-stat etc.) overflow.
     Allow horizontal scroll so reviewers can pan; max-height caps vertical too. */
  .comp-preview { padding: 32px; background: ${canvasHex}; overflow: auto; max-height: 720px; }
  .comp-preview::-webkit-scrollbar { height: 8px; width: 8px; }
  .comp-preview::-webkit-scrollbar-thumb { background: ${isLight(canvasHex) ? '#ccc' : '#444'}; border-radius: 4px; }

  /* ── Markdown blocks (mdBlockToHtml output) */
  .ds-prose-block { max-width: 80ch; margin: 16px 0; }
  .ds-prose-block .ds-prose { margin: 0 0 12px; }
  .ds-prose-block .ds-prose:last-child { margin-bottom: 0; }
  .ds-prose-block .ds-h2 { font-family: '${esc(display.name)}', serif; font-size: 24px; margin: 24px 0 12px; }
  .ds-prose-block .ds-h3 { font-size: 16px; font-weight: 700; margin: 20px 0 8px; opacity: 0.9; }
  .ds-prose-block .ds-h4 { font-size: 14px; font-weight: 700; margin: 18px 0 6px; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.06em; }
  .ds-prose-block .ds-list { margin: 8px 0 16px; padding-left: 24px; }
  .ds-prose-block .ds-list li { margin: 4px 0; line-height: 1.55; }
  .ds-prose-block .ds-list li code { font-size: 0.92em; }
  .ds-prose-block .ds-code { margin: 12px 0; }
  .ds-table { border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  .ds-table th, .ds-table td { padding: 8px 12px; border: 1px solid ${isLight(canvasHex) ? '#e5e5e5' : '#222'}; vertical-align: top; text-align: left; }
  .ds-table th { background: ${isLight(canvasHex) ? '#fafafa' : '#181818'}; font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
  .ds-table td code { font-size: 0.92em; }
  `
}

// ═══════════════════ Assemble ════════════════════════════
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(brandName)} × ${esc(preset.label)} — design.html</title>
<!--
  AGENT NOTE — design.html (product-launch-video Phase 1b output)
  Brand DNA from: ${esc(sourceUrl)}
  Style preset:   ${esc(preset.name)} (${mode})
  Generated:      ${new Date().toISOString()}

  Downstream usage (Phase 4b scene workers):
    - §2: grep <!-- ROOT-START --> .. <!-- ROOT-END --> → paste into scene <style>
    - §4: grep <!-- MOTION-START --> .. <!-- MOTION-END --> → paste into <script>
    - §5: grep <!-- VOICE-START --> .. <!-- VOICE-END --> → register for DOM text copy
    - §H: grep <!-- HINTS-START --> .. <!-- HINTS-END --> → composition rules for plan agent
    - §6: grep <!-- COMPONENT: <name> --> .. <!-- /COMPONENT --> → paste by name
-->
${(() => {
  const url = gfontsUrl()
  if (!url) return '<!-- (all type roles self-hosted; no Google Fonts request) -->'
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${url}" rel="stylesheet">`
})()}
${(() => {
  // Preset-native chrome fonts (preset-meta.chromeFonts.googleFontsHref).
  // Loads e.g. Alfa Slab One + Source Sans 3 + Caveat Brush + DM Mono so the
  // doc chrome (title, section heads, lede) renders in the preset's native
  // typography regardless of brand DNA. Also enables .preset-native-scope in §6.
  const chromeFonts = preset.chromeFonts
  const chromeHref = chromeFonts?.googleFontsHref
  if (!chromeHref)
    return '<!-- (preset declares no chromeFonts — doc chrome uses brand DNA fonts) -->'
  return `<!-- preset chromeFonts: native typography for doc chrome + .preset-native-scope -->
<link href="${esc(chromeHref)}" rel="stylesheet">`
})()}
<style>
${localFontFaceBlock}
${renderPageStyles()}
${extractPagePresetCss()}
</style>
</head>
<body>

${renderTitleCard()}

<main class="wrap">
${renderBrandDNA()}
${renderColorAndTokens()}
${renderTypography()}
${renderMotion()}
${renderVoice()}
${renderHints()}
${renderComponents()}
${renderCaptions()}
</main>

</body>
</html>
`

// ═══════════════════ Write inference.json ════════════════
// Always written — even on --no-emit and --style — so the design-system
// subagent (Phase 1b) can review the ranked candidate pool, the matched
// signals, and the site DNA in one structured file before deciding whether
// to override the baseline winner.
function summariseCandidate(s) {
  const p = presets.find((pp) => pp.name === s.name)
  return {
    name: s.name,
    label: p?.label || s.name,
    raw: Number(s.raw.toFixed(3)),
    normalized: Number(s.normalized.toFixed(3)),
    combined: Number(s.combined.toFixed(3)),
    combined_pre_capability: Number((s.combined_pre_capability ?? s.combined).toFixed(3)),
    matched_signals: s.matched,
    capabilities_missing: s.capabilities_missing || [],
    fingerprint: p?.fingerprint || {},
    best_for: p?.bestFor || [],
    avoid_for: p?.avoidFor || [],
    sectionA_excerpt: (p?.sections?.A?.content || '').slice(0, 800)
  }
}
function summariseTopCandidates(n) {
  if (!scores) return []
  // Only include eligible (capability-satisfied) candidates in top_candidates.
  const winnerScore = scores[0]?.combined || 0
  return scores
    .filter((s) => s.combined > 0)
    .slice(0, n)
    .map((s) => ({
      ...summariseCandidate(s),
      delta_from_winner: Number((winnerScore - s.combined).toFixed(3))
    }))
}
// Capability-gated: would have scored well but is missing runtime / env reqs.
// Subagent reads this to know "if I install X, this preset becomes available".
function summariseCapabilityGated() {
  if (!scores) return []
  return scores
    .filter((s) => s.capabilities_missing && s.capabilities_missing.length > 0)
    .map(summariseCandidate)
}
// confidence: high if winner clearly ahead, low if next candidate is within 0.05.
// Only considers eligible (combined > 0) candidates.
function inferConfidence() {
  const eligible = (scores || []).filter((s) => s.combined > 0)
  if (eligible.length < 2) return 'high'
  const delta = eligible[0].combined - eligible[1].combined
  if (delta < 0.05) return 'low'
  if (delta < 0.12) return 'medium'
  return 'high'
}
// First-screen screenshot, relative to the PROJECT_DIR (the agent's cwd) so the
// brand-review step can open it directly.
function firstScreenshot() {
  try {
    const dir = path.join(captureDir, 'screenshots')
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^scroll-.*\.(png|jpe?g)$/i.test(f))
      .sort()
    if (files.length) {
      return path.relative(path.resolve(outDir, '..'), path.join(dir, files[0]))
    }
  } catch {}
  return null
}
// Brand block: the auto-classified triplet + the ranked candidate pool + a
// confidence + a screenshot, so the design-system agent can review and override
// the primary via `--brand-primary <hex>` when confidence is low (see guide.md).
const _brandConf = brandConfidence(_brandChrom)
const brandReport = {
  primary: _brand.primary,
  secondary: _brand.secondary,
  accent: _brand.accent,
  source: cliBrandPrimary ? 'agent-override' : _brandChrom ? 'signals' : 'legacy',
  confidence: cliBrandPrimary ? 'agent-override' : _brandChrom ? _brandConf.label : 'legacy',
  // review needed when the auto-pick is ambiguous and the agent hasn't yet
  // overridden — the agent should open `screenshot` and pick from `candidates`.
  needs_review: !cliBrandPrimary && !!_brandChrom && _brandConf.label !== 'high',
  screenshot: firstScreenshot(),
  candidates: (_brandChrom || []).slice(0, 6).map((c) => ({
    hex: c.hex,
    score: c.score,
    bgCount: c.bgCount,
    interactiveBg: c.interactiveBg,
    on_button: c.onButton
  }))
}
const inferenceReport = {
  mode,
  selected: { name: preset.name, label: preset.label },
  confidence: mode === 'forced' ? 'forced' : inferConfidence(),
  brand: brandReport,
  baseline_winner:
    scores && scores.find((s) => s.combined > 0)
      ? {
          name: scores.find((s) => s.combined > 0).name,
          combined: Number(scores.find((s) => s.combined > 0).combined.toFixed(3))
        }
      : null,
  top_candidates: summariseTopCandidates(5),
  // Presets whose match_signals would put them in the top-N but a runtime /
  // environment requirement is unmet. Each entry includes `capabilities_missing`
  // with `auto_install` commands the subagent can run to materialise the dep.
  // If empty, no preset is currently gated — all eligible candidates compete.
  capability_gated_presets: summariseCapabilityGated(),
  site_features: features || {},
  site_dna: {
    source: sourceUrl || null,
    brand_name: brandName,
    material: dna?.materialLanguage?.label || null,
    imagery: dna?.imageryStyle?.label || null,
    background_patterns: dna?.backgroundPatterns?.labels || [],
    page_intent: intent?.pageIntent?.type || null,
    section_role_counts: intent?.sectionRoles?.counts || {},
    voice_tone: voice?.tone || null,
    voice_heading_style: voice?.headingStyle || null,
    voice_heading_length: voice?.headingLengthClass || null
  },
  generated_at: new Date().toISOString()
}
fs.mkdirSync(path.dirname(outScoresFile), { recursive: true })
fs.writeFileSync(outScoresFile, JSON.stringify(inferenceReport, null, 2))

// Surface the brand pick + whether the agent should review it via screenshot.
console.log(
  `  brand:    ${brandReport.primary} primary (${brandReport.source}, confidence=${brandReport.confidence})`
)
if (brandReport.needs_review) {
  console.log(
    `  ⚠ brand review: ambiguous pick — open ${brandReport.screenshot || 'first-screen screenshot'}, ` +
      `choose the real brand color from inference.json.brand.candidates, ` +
      `then re-run with --brand-primary <hex>`
  )
}

// ═══════════════════ Write design.html + report ══════════
if (cliNoEmit) {
  console.log(
    `✓ ${path.relative(process.cwd(), outScoresFile)} (inference only; --no-emit, design.html skipped)`
  )
  console.log(`  preset:   ${preset.name} (${mode}, confidence=${inferenceReport.confidence})`)
  if (mode === 'inferred' && scores) {
    console.log(
      `    top-5:  ${scores
        .slice(0, 5)
        .map((s) => `${s.name}=${s.combined.toFixed(2)}`)
        .join(' · ')}`
    )
  }
  process.exit(0)
}
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, html)
const sizeKb = (Buffer.byteLength(html) / 1024).toFixed(1)
console.log(`✓ ${path.relative(process.cwd(), outFile)} (${sizeKb}KB)`)
console.log(`✓ ${path.relative(process.cwd(), outScoresFile)} (inference report)`)
console.log(`  source:   ${sourceUrl || '(no source)'}`)
console.log(`  brand:    ${brandName} · ${materialLabel} material · ${intentLabel} intent`)
console.log(
  `  palette:  ${primaryHex} primary · ${secondaryHex} secondary · ${tertiaryHex} tertiary · ${accentHex} accent · ${costumeHex} costume`
)
console.log(`  deco:     ${decoColors.join(' · ')}`)
console.log(
  `  fonts:    ${display.name} display · ${body.name} body · ${mono.name} mono${script ? ` · ${script.name} script` : ''}`
)
const fontRolesToReport = [
  ['display', display],
  ['body', body],
  ['mono', mono]
]
if (script) fontRolesToReport.push(['script', script])
for (const [roleName, role] of fontRolesToReport) {
  if (role.source === 'preset') {
    if (role.originalName) {
      console.log(
        `    ! ${roleName.padEnd(7)}: '${role.originalName}' not resolvable → ${role.name}`
      )
    } else {
      console.log(
        `    ! ${roleName.padEnd(7)}: site has no ${roleName} face → ${role.name} (preset fallback)`
      )
    }
  } else if (role.source === 'site-local') {
    const fileList = role.localFiles.map((f) => path.basename(f)).join(', ')
    console.log(`    ✓ ${roleName.padEnd(7)}: '${role.name}' self-hosted (${fileList})`)
  }
}
if (copiedFontFiles.length > 0) {
  console.log(
    `  fonts/:   ${copiedFontFiles.length} file(s) copied to ${path.relative(process.cwd(), path.join(outDir, 'fonts'))}/`
  )
}
console.log(`  preset:   ${preset.name} (${mode}, confidence=${inferenceReport.confidence})`)
if (scores && scores.length) {
  console.log(
    `    scores: ${scores
      .slice(0, 5)
      .map((s) => `${s.name}=${s.combined.toFixed(2)}`)
      .join(' · ')}`
  )
  const trueFeatures = Object.entries(features)
    .filter(([, v]) => v)
    .map(([k]) => k)
  if (trueFeatures.length) console.log(`    matched signals: ${trueFeatures.join(', ')}`)
}
console.log(`  components: ${preset.components.length} paste-ready`)
