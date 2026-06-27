#!/usr/bin/env node

// captions.mjs — merged caption pipeline CLI. Dispatches by subcommand:
//   group   → (was build-captions.mjs)       deterministic caption grouping
//             usage: node captions.mjs group --group-spec ./group_spec.json
//                    --hyperframes . --tokens design-system/chunks/tokens.css
//                    --out ./caption_groups.json
//   html    → (was build-captions-html.mjs)  deterministic caption-HTML builder
//             usage: node captions.mjs html --hyperframes . --groups ./caption_groups.json
//                    --tokens design-system/chunks/tokens.css
//                    [--inference design-system/inference.json]
//                    [--out compositions/captions.html]
//                    [--skin caption-pill-karaoke] [--skin-file <path>] [--no-emit]
//   keepout → (was check-caption-keepout.mjs) static caption keep-out gate
//             usage: node captions.mjs keepout --group-spec ./group_spec.json
//                    --hyperframes . [--json]
//
// Each original file's body is wrapped verbatim in its own async function so
// its local const/function names stay function-local and never collide. The
// only edit inside each body: CLI args read from the passed-in `argv` param
// (the dispatcher passes process.argv.slice(3), i.e. args after the subcommand).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { captionBand, readDims } from './lib/dimensions.mjs'

// =====================================================================
// group  — was build-captions.mjs
// =====================================================================
// Phase 4a.5 (engine) — deterministic caption grouping. No subagent.
//
// Owns the word-data half of the captions contract (clean / group / global-time
// / class + the non-overlap invariant). Its output, caption_groups.json, is the
// single source of grouping/timing truth consumed by the deterministic HTML
// builder build-captions-html.mjs (no LLM, no hand-authored spans).
// Color/contrast decisions are NOT made here — color-mix()/var() can only be
// resolved by a browser at render time, so the A-lite scene-background
// adaptation lives in the caption template's render-time <script>, not here.
// This script only carries each group's `scene_id` + `surface` through so the
// template knows which scene a caption sits over.
//
// Reads:  ./group_spec.json (Phase 4a — groups[].scenes[<sid>].{start_s,
//           estimatedDuration_s, wordsPath, surface}); each scene's
//           wordsPath → assets/voice/scene_<N>_words.json (Phase 2.5 whisper
//           output, [{text,start,end}] in SCENE-LOCAL seconds);
//           design-system/chunks/tokens.css (existence gate only).
// Writes:  ./caption_groups.json (cleaned / grouped / tagged / globally-timed
//           word groups + stats + anomalies[]).
//
// Usage:
//   node captions.mjs group --group-spec ./group_spec.json \
//        --hyperframes . --tokens design-system/chunks/tokens.css \
//        --out ./caption_groups.json
//
// Exit 0 = caption_groups.json written, OR a documented SKIP (prints
//          "captions: skipped (<reason>)" — finalize keys off file existence,
//          so a skip is not an error). Skips: group_spec missing; no scene has
//          an existing/valid wordsPath; tokens.css missing.
// Exit 1 = structural failure only (group_spec unreadable JSON; a wordsPath
//          that is present but malformed JSON). Non-fatal issues → anomalies[].
async function runGroup(argv) {
  // ---------- argv ----------
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
  }
  function die(msg) {
    console.error(`✗ build-captions.mjs: ${msg}`)
    process.exit(1)
  }
  function skip(reason) {
    // Skip is not an error: finalize decides track-12 by file existence, and a
    // missing caption_groups.json simply means the captions agent also skips.
    console.log(`captions: skipped (${reason})`)
    process.exit(0)
  }

  const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
  const hyperframesDir = resolve(flag('hyperframes', '.'))
  const tokensPath = resolve(hyperframesDir, flag('tokens', 'design-system/chunks/tokens.css'))
  const outPath = resolve(flag('out', './caption_groups.json'))

  // ---------- skip gates ----------
  if (!existsSync(groupSpecPath)) skip('no group_spec')
  if (!existsSync(tokensPath)) skip('no brand tokens')

  let spec
  try {
    spec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
  } catch (e) {
    die(`group_spec.json is not valid JSON: ${e.message}`)
  }
  const groups = Array.isArray(spec.groups) ? spec.groups : []
  if (groups.length === 0) skip('group_spec has no groups')

  const anomalies = []

  // ---------- §1: load word stream, scene-local → global, carry scene_id+surface ----------
  // Outer loop over groups in array order, inner loop over each group's
  // scene_ids in array order (group_spec is a list of worker-groups, each with
  // its own scenes map — there is NO top-level scenes map).
  const rawWords = []
  let scenesWithWords = 0
  for (const g of groups) {
    for (const sid of g.scene_ids || []) {
      const sc = (g.scenes || {})[sid]
      if (!sc) {
        anomalies.push(`${sid}: listed in scene_ids but missing from scenes map — skipped`)
        continue
      }
      const wordsPath = sc.wordsPath // prep writes "" (not absent) when no/invalid file
      if (!wordsPath) continue // empty string === "no words for this scene"
      const abs = join(hyperframesDir, wordsPath)
      if (!existsSync(abs)) {
        anomalies.push(
          `${sid}: wordsPath "${wordsPath}" not on disk — scene contributes no captions`
        )
        continue
      }
      let arr
      try {
        arr = JSON.parse(readFileSync(abs, 'utf8'))
      } catch (e) {
        // A present-but-malformed wordsPath is a structural failure: prep claimed
        // this scene had transcribed words, so a parse error is a real break.
        die(`${sid}: wordsPath "${wordsPath}" is present but not valid JSON: ${e.message}`)
      }
      if (!Array.isArray(arr) || arr.length === 0) {
        anomalies.push(`${sid}: wordsPath "${wordsPath}" is empty — scene contributes no captions`)
        continue
      }
      const offset = Number(sc.start_s)
      if (!isFinite(offset)) {
        anomalies.push(`${sid}: start_s "${sc.start_s}" not finite — using 0`)
      }
      const base = isFinite(offset) ? offset : 0
      const surface = sc.surface ?? null // named surface token or null (non-surface-aware preset)
      let kept = 0
      for (const w of arr) {
        const text = typeof w.text === 'string' ? w.text : typeof w.word === 'string' ? w.word : ''
        const start = Number(w.start)
        const end = Number(w.end)
        if (!text || !isFinite(start) || !isFinite(end) || end <= start) {
          continue // silently drop unusable word entries (timestamps unreliable)
        }
        rawWords.push({ text, start: base + start, end: base + end, scene_id: sid, surface })
        kept++
      }
      if (kept > 0) scenesWithWords++
    }
  }

  if (scenesWithWords === 0) skip('no whisper words')

  // ---------- §2: clean the word stream ----------
  const MUSIC_RE = /^[♪♯�\s-]+$/ // ♪ ♯ replacement-char / dashes only
  const FILLER = new Set(['uh', 'um', 'ah', 'oh', 'huh'])
  const HAS_ALNUM = /[A-Za-z0-9]/
  let droppedMusic = 0
  let droppedPunct = 0
  let droppedShort = 0
  let droppedFiller = 0
  const cleaned = []
  for (const w of rawWords) {
    const t = w.text.trim()
    if (t === '' || MUSIC_RE.test(t)) {
      droppedMusic++
      continue
    }
    if (!HAS_ALNUM.test(t)) {
      // Entirely non-alphanumeric (lone "." / "," / "—") — cannot stand as a word.
      // Punctuation ATTACHED to a word ("Figma.") keeps it — it has alnum chars.
      droppedPunct++
      continue
    }
    const dur = w.end - w.start
    if (dur < 0.05) {
      droppedShort++
      continue
    }
    if (FILLER.has(t.toLowerCase().replace(/[^a-z]/g, '')) && dur < 0.1) {
      droppedFiller++
      continue
    }
    cleaned.push(w)
  }

  if (cleaned.length === 0) skip('no whisper words')

  // ---------- §3: group the word stream ----------
  // Hard rules (never violated):
  //   1. cross-scene boundary (scene_id change) → force new group
  //   2. sentence-end punctuation suffix on a word → close group AFTER that word
  //   3. silence gap (word.start − prev.end > 0.18s) → new group
  //   4. word cap (density-modulated, default 4) → force close
  // Soft rhythm guidance is encoded deterministically as a density-aware cap:
  // dense narration (local >2.5 w/s) shortens groups; lyrical (<1.5 w/s) allows 4.
  const SILENCE_GAP = 0.18
  const SENTENCE_END_RE = /[.?!,;:—]$/ // . ? ! , ; : —
  const TAIL_PAD = 0.12 // extra hold so the last word is readable

  // Local density at index i = words whose start falls within [start, start+1.0s).
  function effectiveCap(i) {
    const t0 = cleaned[i].start
    let n = 0
    for (let j = i; j < cleaned.length && cleaned[j].start < t0 + 1.0; j++) n++
    if (n > 3.5) return 2
    if (n > 2.5) return 3
    return 4
  }

  let densityShortened = 0
  let crossSceneSplits = 0
  let silenceGapSplits = 0
  let punctSplits = 0
  let capSplits = 0
  const grouped = [] // arrays of word objects
  let cur = []
  let curCap = 4
  for (let i = 0; i < cleaned.length; i++) {
    const w = cleaned[i]
    const prev = cur.length ? cur[cur.length - 1] : null
    const crossScene = prev && w.scene_id !== prev.scene_id
    const silenceGap = prev && w.start - prev.end > SILENCE_GAP
    if (cur.length && (crossScene || silenceGap || cur.length >= curCap)) {
      // attribute the split (priority: scene boundary > silence > word cap)
      if (crossScene) crossSceneSplits++
      else if (silenceGap) silenceGapSplits++
      else capSplits++
      grouped.push(cur)
      cur = []
    }
    if (cur.length === 0) {
      curCap = effectiveCap(i)
      if (curCap < 4) densityShortened++
    }
    cur.push(w)
    if (SENTENCE_END_RE.test(w.text)) {
      punctSplits++
      grouped.push(cur)
      cur = []
    }
  }
  if (cur.length) grouped.push(cur)
  // The final flush is not a split; the loop counted one split per boundary
  // crossed, which is exactly (groups − 1) boundaries — no off-by-one to correct.

  // ---------- §4: ALL-CAPS / numeric tagging (free emphasis, no upstream tag) ----------
  function classesFor(text) {
    const cls = []
    const letters = text.match(/[A-Za-z]/g) || []
    if (letters.length >= 2 && !/[a-z]/.test(text)) cls.push('is-allcaps')
    if (/^[0-9]/.test(text)) cls.push('is-numeric')
    return cls
  }

  let isAllcaps = 0
  let isNumeric = 0
  const outGroups = grouped.map((words, gi) => {
    const start = words[0].start
    // Hold the last word up to TAIL_PAD ms longer — but never past the next
    // group's first word, or the GSAP hard-kill would fire AFTER the next group
    // appears and two groups would be on screen at once (guide §9 top failure).
    const nextStart = gi + 1 < grouped.length ? grouped[gi + 1][0].start : Infinity
    const end = Math.min(words[words.length - 1].end + TAIL_PAD, nextStart)
    const text = words.map((w) => w.text).join(' ')
    return {
      id: `caption-group-${gi}`,
      scene_id: words[0].scene_id,
      surface: words[0].surface ?? null,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      text,
      words: words.map((w, wi) => {
        const classes = classesFor(w.text)
        if (classes.includes('is-allcaps')) isAllcaps++
        if (classes.includes('is-numeric')) isNumeric++
        return {
          id: `caption-word-${gi}-${wi}`,
          text: w.text,
          start: Number(w.start.toFixed(3)),
          end: Number(w.end.toFixed(3)),
          classes
        }
      })
    }
  })

  // ---------- §8 invariant: intra-scene groups must not temporally overlap ----------
  // (Two visible at once is guide §9's top failure. We catch it here, on data,
  // before any HTML is authored — never by seeking a GSAP timeline.)
  for (let i = 1; i < outGroups.length; i++) {
    const a = outGroups[i - 1]
    const b = outGroups[i]
    if (a.scene_id === b.scene_id && b.start < a.end) {
      anomalies.push(
        `group overlap: ${a.id} ends ${a.end} but ${b.id} starts ${b.start} (same scene ${a.scene_id})`
      )
    }
  }

  const { width: cgW, height: cgH } = readDims(spec)
  const out = {
    total_duration_s: Number(spec.total_duration_s) || 0,
    // Canvas size flows group_spec → here → captions.mjs html (which sizes the
    // skin root). Landscape default for pre-dims specs.
    width: cgW,
    height: cgH,
    source_word_count: rawWords.length,
    cleaned_word_count: cleaned.length,
    groups: outGroups,
    stats: {
      groups: outGroups.length,
      cross_scene_splits: crossSceneSplits,
      silence_gap_splits: silenceGapSplits,
      punct_splits: punctSplits,
      cap_splits: capSplits,
      density_shortened: densityShortened,
      is_allcaps: isAllcaps,
      is_numeric: isNumeric,
      dropped: {
        music: droppedMusic,
        punct: droppedPunct,
        short: droppedShort,
        filler: droppedFiller
      }
    },
    anomalies
  }

  writeFileSync(outPath, JSON.stringify(out, null, 2))

  // ---------- summary ----------
  console.log(`✓ wrote ${outPath}`)
  console.log(
    `  source words: ${rawWords.length} → cleaned: ${cleaned.length} → groups: ${outGroups.length}`
  )
  console.log(
    `  splits — cross-scene:${crossSceneSplits} silence:${silenceGapSplits} punct:${punctSplits} cap:${capSplits}  /  density-shortened: ${densityShortened}`
  )
  console.log(`  is-allcaps: ${isAllcaps}  /  is-numeric: ${isNumeric}`)
  console.log(
    `  dropped — music:${droppedMusic} punct:${droppedPunct} short:${droppedShort} filler:${droppedFiller}`
  )
  if (anomalies.length) {
    console.log(`\nanomalies (non-fatal):`)
    for (const a of anomalies) console.log(`  - ${a}`)
  }
}

// =====================================================================
// html  — was build-captions-html.mjs
// =====================================================================
// Phase 4a.5 (engine) — deterministic caption-HTML builder. No subagent.
//
// Replaces the old captions LLM agent (agents/captions.md, now deleted). Turns
// the deterministic word data from build-captions.mjs into a brand-strict,
// render-ready caption sub-composition WITHOUT any LLM judgment — killing the
// whole class of agent-authored render-time footguns the old guide §6/§7 warned
// about (Illegal-invocation, timeline-not-registered, naked-color brand leaks,
// two-groups-visible, fitText-return-ignored).
//
// Pipeline position:
//   build-captions.mjs  → caption_groups.json   (clean/group/global-time/class)
//   build-captions-html.mjs (THIS)  → compositions/captions.html   (skin + brand)
//   assemble-index.mjs  → mounts it as the track-12 clip IF the file exists
//
// What it does:
//   1. SKIP gates (parity with build-captions.mjs / old agent): exit 0 with a
//      "captions: skipped (<reason>)" line so finalize simply omits track-12.
//   2. SCORE + pick one of the SUPPORTED registry skins from inference.json
//      (deterministic rubric; --skin forces; --no-emit reports without building).
//   3. INSTALL the skin (`npx hyperframes add caption-<skin>`, or --skin-file
//      for offline/CI), then TRANSFORM it via a per-skin descriptor:
//        - replace the placeholder transcript with caption_groups words
//        - feed the engine's pre-computed groups (scene-aware, non-overlapping)
//          so the skin never re-groups scene-blind  [fixes blocker B5]
//        - rewrite `var DURATION = 8` → total_duration_s  [fixes blocker B1:
//          the 8s placeholder clamps every word past 8s on a 60-90s video]
//        - rename host data-composition-id AND window.__timelines key → "captions"
//          (both must match: compositionScoping only remaps the timeline write
//          when the key === the inner root's data-composition-id)
//        - inline tokens.css + tokenize every hardcoded color/font to var(--*)
//          / color-mix(...) so the file is brand-strict
//        - convert the karaoke color tween to an .is-active CLASS flip so the
//          active/inactive colors live in CSS tokens (gsap can't interpolate
//          var() colors)  [keeps brand-strict + readable on any brand theme,
//          addressing blocker B6 structurally: pill bg = var(--canvas), active
//          text = var(--ink) → always contrast, no render-time probe needed]
//        - add a full-span timeline anchor so the sub-comp timeline duration
//          spans the whole video
//   4. NODE structural self-lint (replaces the old browser self-lint; check-
//      compositions.mjs does NOT scan captions.html, so this is the sole gate).
//
// SUPPORTED SKINS:
//   - caption-pill-karaoke — own opaque pill (no scrim needed), canonical
//     .caption-group/.caption-word classes, a runtime makeGroups we bypass,
//     lower-third position, CSS-only colors. The safe default.
//   - caption-highlight — TikTok-style per-word background sweep. Audited in
//     behind its own transform: it ships NON-canonical .hl-group/.hl-word
//     classes (we add the canonical ones alongside), an INDEX-PINNED RAW_GROUPS
//     map keyed to the demo transcript (we replace it with the engine's
//     scene-aware groups), and a TRANSPARENT layer (we tokenize its full-screen
//     .hl-overlay into a brand-strict lower-third scrim band so text stays
//     readable over any scene). CSS-only colors → tokenizable; bottom-anchored.
// The remaining registry caption-* skins still need per-skin work (JS-computed
// colors, mid-canvas position, line-only animation with no word class) and are
// added one at a time behind their own descriptor — see phases/captions/guide.md.
//
// Usage:
//   node captions.mjs html --hyperframes . --groups ./caption_groups.json \
//        --tokens design-system/chunks/tokens.css \
//        [--inference design-system/inference.json] \
//        [--out compositions/captions.html] \
//        [--skin caption-pill-karaoke] [--skin-file <path>] [--no-emit]
//
// Exit 0 = compositions/captions.html written, OR a documented SKIP.
// Exit 1 = structural failure (bad JSON, skin handle drift, self-lint failure).
async function runHtml(argv) {
  // ---------- argv ----------
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
  }
  const has = (name) => argv.includes(`--${name}`)

  function die(msg) {
    console.error(`✗ build-captions-html.mjs: ${msg}`)
    process.exit(1)
  }
  function skip(reason) {
    // Skip is not an error: finalize decides track-12 by file existence, so a
    // missing captions.html simply means no caption layer.
    console.log(`captions: skipped (${reason})`)
    process.exit(0)
  }

  const hyperframesDir = resolve(flag('hyperframes', '.'))
  const groupsPath = resolve(flag('groups', './caption_groups.json'))
  const tokensPath = resolve(hyperframesDir, flag('tokens', 'design-system/chunks/tokens.css'))
  const inferencePath = resolve(hyperframesDir, flag('inference', 'design-system/inference.json'))
  const outPath = resolve(hyperframesDir, flag('out', 'compositions/captions.html'))
  const forcedSkin = flag('skin', null)
  const skinFile = flag('skin-file', null)
  const noEmit = has('no-emit')

  // ---------- per-skin descriptor table ----------
  // Each entry pins the exact handles for one registry skin so the transform leans
  // on the genuinely-shared contract (paused gsap timeline → window.__timelines,
  // GSAP via CDN, a single <video> placeholder, an inline transcript array) and
  // asserts the per-skin deltas rather than discovering them. Adding a skin = one
  // entry + (if it diverges) extending applyTransform. A registry drift that moves
  // a handle fails loudly at build time, never silently blank captions.
  const SKINS = {
    'caption-pill-karaoke': {
      supported: true,
      has_own_bg: true,
      componentFile: 'compositions/components/caption-pill-karaoke.html',
      // vibe weights for scoreSkins (matched against inference signals)
      vibe: { neutral: 1, saas: 1, rounded: 1, friendly: 1 }
    },
    'caption-highlight': {
      supported: true,
      has_own_bg: false, // transparent → transform injects a brand-strict scrim band
      componentFile: 'compositions/components/caption-highlight.html',
      // bold/energetic/social — wins auto-pick only on a "direct" voice tone or a
      // loud preset (see scoreSkins); otherwise pill-karaoke stays the safe default.
      vibe: { bold: 1, social: 1, energetic: 1 }
    },
    // Not yet supported — present so scoring/--skin can report a clear
    // "needs per-skin work" message instead of a generic failure:
    'caption-neon-accent': {
      supported: false,
      reason: "JS-computed hex glow colors can't be brand-tokenized"
    },
    'caption-emoji-pop': {
      supported: false,
      reason: 'JS-computed colors + hardcoded English keyword/emoji map'
    },
    'caption-weight-shift': {
      supported: false,
      reason: 'no .caption-word class (animates lines) — Studio detection gap'
    },
    'caption-clip-wipe': {
      supported: false,
      reason: '.wp-* classes + index-pinned RAW_GROUPS/KEYWORDS'
    },
    'caption-editorial-emphasis': {
      supported: false,
      reason: 'mid-canvas (top:580px) — incompatible with lower-third band'
    }
  }

  // ---------- skip gates ----------
  if (!existsSync(groupsPath)) skip('no caption groups')
  if (!existsSync(tokensPath)) skip('no brand tokens')

  let cg
  try {
    cg = JSON.parse(readFileSync(groupsPath, 'utf8'))
  } catch (e) {
    die(`caption_groups.json is not valid JSON: ${e.message}`)
  }
  const groups = Array.isArray(cg.groups) ? cg.groups : []
  if (groups.length === 0) skip('no caption groups')
  const totalDuration = Number(cg.total_duration_s)
  if (!isFinite(totalDuration) || totalDuration <= 0)
    die(`caption_groups.total_duration_s missing/invalid (${cg.total_duration_s})`)

  // Canvas size — stamped into caption_groups.json by `group`; landscape default.
  // Skin root + body box are retargeted to these in buildPresetSkin.
  const { width: skinW, height: skinH } = readDims(cg)

  const tokensCss = readFileSync(tokensPath, 'utf8')

  // ---------- transform helpers (assert-or-die) — shared by both skin sources ----------
  function replaceOnce(html, find, replacement, label) {
    if (typeof find === 'string') {
      const idx = html.indexOf(find)
      if (idx === -1)
        die(`transform "${label}": expected literal not found (registry skin drifted?)`)
      if (html.indexOf(find, idx + find.length) !== -1)
        die(`transform "${label}": literal appears more than once`)
      return html.slice(0, idx) + replacement + html.slice(idx + find.length)
    }
    // regex
    const matches = html.match(new RegExp(find.source, find.flags.replace('g', '') + 'g'))
    if (!matches || matches.length === 0)
      die(`transform "${label}": pattern not found (registry skin drifted?)`)
    return html.replace(find, replacement)
  }
  function replaceAll(html, find, replacement, label) {
    if (!html.includes(find)) die(`transform "${label}": expected literal not found`)
    return html.split(find).join(replacement)
  }

  // Brand display family name for any canvas measureText() fit math (a CSS var() can't be
  // a canvas font; the visible font still uses var(--font-display)). Shared by every skin.
  const fdm = /--font-display:\s*'([^']+)'/.exec(tokensCss)
  const brandDisplay = fdm ? fdm[1] : 'Poppins'

  // ---------- §0: preset-local caption skin (second source, preferred when present) ----------
  // emit-chunks copies a preset's own caption-skin.html (style-presets/<preset>/caption-skin.html)
  // into chunks/ for the chosen preset, so its presence beside tokens.css here means "this preset
  // ships its own caption look". It is authored pre-baked + brand-token-strict against the canonical
  // contract (data-composition-id=captions, .caption-group/.caption-word, var(--*) colors), so the
  // transform is a GENERIC fill shared by every preset — no per-preset code. Precedence:
  //   --skin <registry>  forces a registry skin · --no-preset-skin disables this ·
  //   otherwise a present caption-skin.html wins over registry scoring.
  const presetSkinPath = resolve(dirname(tokensPath), 'caption-skin.html')
  const usePresetSkin = !forcedSkin && !has('no-preset-skin') && existsSync(presetSkinPath)

  function buildPresetSkin(src) {
    // Engine groups → the shape the skin's buildCaptions()/timeline consume; times are already
    // GLOBAL seconds + scene-aware / non-overlapping (build-captions.mjs), same as the pill path.
    const engineGroups = groups.map((g) => ({
      start: Number(g.start),
      end: Number(g.end),
      words: (g.words || []).map((w) => ({
        text: String(w.text),
        start: Number(w.start),
        end: Number(w.end)
      }))
    }))
    let h = src
    h = replaceOnce(
      h,
      'var GROUPS = [];',
      `var GROUPS = ${JSON.stringify(engineGroups)};`,
      'preset engine groups'
    )
    h = replaceOnce(h, 'var DURATION = 0;', `var DURATION = ${totalDuration};`, 'preset DURATION')
    h = replaceOnce(
      h,
      'data-duration="0"',
      `data-duration="${totalDuration}"`,
      'preset host data-duration'
    )
    // optional: a skin that does canvas-measure fitting leaves an empty FONT_FAMILY to fill.
    if (h.includes('var FONT_FAMILY = "";')) {
      h = replaceOnce(
        h,
        'var FONT_FAMILY = "";',
        `var FONT_FAMILY = ${JSON.stringify(brandDisplay)};`,
        'preset FONT_FAMILY'
      )
    }
    h = replaceOnce(
      h,
      '<style data-brand-tokens></style>',
      `<style data-brand-tokens>\n${tokensCss.trim()}\n    </style>`,
      'preset brand tokens'
    )
    // Canvas retarget — skins are authored landscape 1920×1080; for portrait/
    // square, rewrite the root data-width/height + the body/root px box (the
    // skins' own `@media (max-aspect-ratio: 9/16)` block then repositions the
    // pill). No-op on landscape, so the common path is byte-identical.
    if (skinW !== 1920 || skinH !== 1080) {
      // Two-phase swap via sentinels: a naive `.split("1920px")…split("1080px")`
      // collides (the px the first pass writes is re-hit by the second), leaving
      // width stuck at 1920 for portrait. Sentinels make the swap simultaneous.
      h = h
        .split('data-width="1920"')
        .join(`data-width="${skinW}"`)
        .split('data-height="1080"')
        .join(`data-height="${skinH}"`)
        .split('1920px')
        .join(' WPX ')
        .split('1080px')
        .join(' HPX ')
        .split(' WPX ')
        .join(`${skinW}px`)
        .split(' HPX ')
        .join(`${skinH}px`)
        .split('width=1920, height=1080')
        .join(`width=${skinW}, height=${skinH}`)
    }
    return h
  }

  // ---------- §a: deterministic skin scoring ----------
  let inference = null
  if (existsSync(inferencePath)) {
    try {
      inference = JSON.parse(readFileSync(inferencePath, 'utf8'))
    } catch {
      inference = null // optional input; ignore malformed
    }
  }

  // Loud/expressive presets (build-design.mjs names) — a site that picked one of
  // these reads punchy enough that the TikTok-style highlight skin fits it.
  const LOUD_PRESETS =
    /neo-brutalism|raw-grid|peoples-platform|8-bit-orbit|retro-zine|neo-grid-bold|stencil-tablet|scatterbrain/

  function scoreSkins() {
    // Deterministic rubric over the SUPPORTED skins, grounded in real
    // inference.json fields (site_dna.voice_tone, selected.name). pill-karaoke is
    // the safe floor (own opaque pill → readable on any scene with no scrim); the
    // bolder, transparent-scrim highlight only overtakes it on a clearly punchy
    // signal. Tie ALWAYS resolves to pill-karaoke (the guide §1 documented default)
    // → fully deterministic, no Date/random.
    const tone = inference?.site_dna?.voice_tone || null // "direct" | "warm" | "neutral" | null
    const selected = inference?.selected?.name || ''
    const score = {
      'caption-pill-karaoke': 1 + (tone === 'warm' || tone === 'neutral' ? 1 : 0),
      'caption-highlight': (tone === 'direct' ? 2 : 0) + (LOUD_PRESETS.test(selected) ? 1 : 0)
    }
    const ranked = Object.entries(SKINS)
      .filter(([, d]) => d.supported)
      .map(([id]) => ({ id, score: score[id] ?? 0 }))
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        (a.id === 'caption-pill-karaoke' ? -1 : b.id === 'caption-pill-karaoke' ? 1 : 0)
    )
    return ranked
  }

  let ranked = null
  let winner
  if (usePresetSkin) {
    winner = 'preset-skin' // resolved from chunks/caption-skin.html (second source)
  } else {
    ranked = scoreSkins()
    if (forcedSkin) {
      const d = SKINS[forcedSkin]
      if (!d) die(`unknown --skin "${forcedSkin}" — not a caption-* skin in the descriptor table`)
      if (!d.supported)
        die(
          `--skin "${forcedSkin}" not yet supported (${d.reason}). Phase 1 supports: caption-pill-karaoke`
        )
      winner = forcedSkin
    } else {
      winner = ranked[0]?.id || 'caption-pill-karaoke'
    }
  }

  if (noEmit) {
    const scoresPath = resolve(hyperframesDir, 'caption_skin_scores.json')
    writeFileSync(
      scoresPath,
      JSON.stringify(
        {
          winner,
          source: usePresetSkin ? 'preset-local' : 'registry',
          ranked,
          inference: !!inference
        },
        null,
        2
      )
    )
    console.log(`✓ (--no-emit) ranked skins → ${scoresPath}`)
    console.log(`  winner: ${winner}${usePresetSkin ? ' (preset-local caption-skin.html)' : ''}`)
    process.exit(0)
  }

  // ---------- §b+§c: resolve + transform the chosen skin ----------
  let html
  if (usePresetSkin) {
    // Preset-local skin (second source): pre-baked + brand-token-strict, so the GENERIC
    // fill (groups + duration + tokens) is the whole transform — no per-skin/per-preset code.
    html = buildPresetSkin(readFileSync(presetSkinPath, 'utf8'))
  } else {
    // ---------- §b: install / load the registry skin ----------
    const desc = SKINS[winner]
    let skinHtml
    if (skinFile) {
      const sf = resolve(skinFile)
      if (!existsSync(sf)) die(`--skin-file "${skinFile}" not found`)
      skinHtml = readFileSync(sf, 'utf8')
    } else {
      // `hyperframes add` only copies the component file into the project; it never
      // edits index.html. Needs registry/network access — fails loudly if offline
      // (unlike the old LLM agent, this script cannot improvise; pass --skin-file
      // for offline/CI golden renders).
      try {
        execFileSync('npx', ['hyperframes', 'add', winner, '--no-clipboard'], {
          cwd: hyperframesDir,
          stdio: 'pipe'
        })
      } catch (e) {
        die(
          `\`npx hyperframes add ${winner}\` failed (offline? pass --skin-file <path>): ${e.message}`
        )
      }
      const compAbs = resolve(hyperframesDir, desc.componentFile)
      if (!existsSync(compAbs)) die(`expected ${desc.componentFile} after add, but it is missing`)
      skinHtml = readFileSync(compAbs, 'utf8')
    }

    // ---------- §c: transform the chosen registry skin ----------
    html = skinHtml

    if (winner === 'caption-pill-karaoke') {
      // ---------- §c1: transform pill-karaoke ----------
      // Engine groups → the shape the skin's buildCaptions()/timeline consume:
      // { start, end, words:[{text,start,end}] }. Times are already GLOBAL seconds and
      // scene-aware / non-overlapping (build-captions.mjs §3 + §8), so feeding them and
      // bypassing the skin's scene-blind makeGroups fixes B5 and the 8s word clamp (B1).
      const engineGroups = groups.map((g) => ({
        start: Number(g.start),
        end: Number(g.end),
        words: (g.words || []).map((w) => ({
          text: String(w.text),
          start: Number(w.start),
          end: Number(w.end)
        }))
      }))
      const groupsJson = JSON.stringify(engineGroups)

      // (1) strip Google Fonts <link> tags (brand @font-face is injected into index.html
      //     by assemble-index; the caption sub-comp is flattened into that document).
      {
        let removed = 0
        html = html.replace(/\s*<link\b[^>]*?>/gi, (m) => {
          if (/fonts\.g(oogleapis|static)/i.test(m)) {
            removed++
            return ''
          }
          return m
        })
        if (removed === 0) die(`transform "strip google fonts": no font <link> found`)
      }

      // (2) strip the demo <video> placeholder element + its now-dead CSS rule.
      if (!/<video\b[^>]*id="avatar-video"/i.test(html))
        die(`transform "strip video": demo <video id=avatar-video> not found`)
      html = html.replace(/\s*<video\b[\s\S]*?<\/video>/i, '')
      html = html.replace(/\s*#avatar-video\s*\{[^}]*\}/i, '')

      // (3) host root: rename composition id + set real duration.
      html = replaceOnce(
        html,
        'data-composition-id="caption-pill-karaoke"',
        'data-composition-id="captions"',
        'host composition-id'
      )
      html = replaceOnce(
        html,
        'data-duration="8"',
        `data-duration="${totalDuration}"`,
        'host data-duration'
      )

      // (4) DURATION clamp [B1].
      html = replaceOnce(html, 'var DURATION = 8;', `var DURATION = ${totalDuration};`, 'DURATION')

      // (5) measurement font → brand display family.
      html = replaceOnce(
        html,
        'var FONT_FAMILY = "Poppins";',
        `var FONT_FAMILY = ${JSON.stringify(brandDisplay)};`,
        'FONT_FAMILY'
      )

      // (6) drop the JS color constants (hex → would trip brand-strict; karaoke now CSS-class driven).
      html = replaceOnce(
        html,
        '      var COLOR_INACTIVE = "#A6A6A6";\n      var COLOR_ACTIVE = "#1C1E1D";',
        '      // karaoke colors are CSS-token driven (.caption-word / .caption-word.is-active)',
        'color consts'
      )

      // (7) kill the placeholder transcript (its text must be gone for the self-lint).
      html = replaceOnce(
        html,
        /var TRANSCRIPT = \[[\s\S]*?\];/,
        'var TRANSCRIPT = [];',
        'TRANSCRIPT placeholder'
      )

      // (8) feed engine groups; bypass normalizeWords + scene-blind makeGroups [B1+B5].
      html = replaceOnce(
        html,
        '      var WORDS = normalizeWords(TRANSCRIPT);\n      var GROUPS = makeGroups(WORDS);',
        `      var GROUPS = ${groupsJson};`,
        'engine groups'
      )

      // (9) karaoke color tween → .is-active class flip (colors come from CSS tokens).
      html = replaceOnce(
        html,
        `        group.words.forEach(function (word, wordIndex) {
          var wordEl = document.getElementById("caption-word-" + groupIndex + "-" + wordIndex);
          var isFirstWord = wordIndex === 0;
          var wordStart = Math.max(visibleStart, word.start - WORD_FADE_LEAD);
          tl.set(wordEl, { color: isFirstWord ? COLOR_ACTIVE : COLOR_INACTIVE }, visibleStart);
          if (isFirstWord) return;
          tl.to(
            wordEl,
            { color: COLOR_ACTIVE, duration: COLOR_FADE_DURATION, ease: "none" },
            wordStart,
          );
        });`,
        `        group.words.forEach(function (word, wordIndex) {
          var wordEl = document.getElementById("caption-word-" + groupIndex + "-" + wordIndex);
          var isFirstWord = wordIndex === 0;
          var wordStart = Math.max(visibleStart, word.start - WORD_FADE_LEAD);
          tl.set(wordEl, { className: "caption-word" }, visibleStart);
          tl.set(wordEl, { className: "caption-word is-active" }, isFirstWord ? visibleStart : wordStart);
        });`,
        'karaoke class flip'
      )

      // (10) full-span timeline anchor + rename the registry key → "captions".
      html = replaceOnce(
        html,
        'window.__timelines["caption-pill-karaoke"] = tl;',
        'tl.to({}, { duration: DURATION }, 0);\n      window.__timelines["captions"] = tl;',
        'timeline key + anchor'
      )

      // (11) tokenize CSS colors/fonts → brand-strict.
      html = replaceAll(
        html,
        'font-family: "Poppins", Arial, sans-serif;',
        'font-family: var(--font-display), Arial, sans-serif;',
        'font-family token'
      )
      html = replaceOnce(
        html,
        'background: #e7e5e7;',
        'background: var(--canvas);',
        'pill bg token'
      )
      html = replaceOnce(
        html,
        'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);',
        'box-shadow: 0 2px 8px color-mix(in srgb, var(--ink) 14%, transparent);',
        'pill shadow token'
      )
      html = replaceAll(
        html,
        'color: #a6a6a6;',
        'color: color-mix(in srgb, var(--ink) 45%, var(--canvas));',
        'inactive color token'
      )

      // (11b) geometry/size → match vito's compact lower-third. pill-karaoke ships a
      // large 72px caption at bottom:100px (top edge ~y760), which (a) reads ~1.6x
      // bigger than vito's 44px pill and (b) sits ABOVE the reserved ~180px band
      // (y900-1080) the scene keep-out (#13) clears — so a scene filling to y900 could
      // still be overlapped. Shrink to ~46px and hug the lower edge (bottom 24px,
      // shorter box → pill bottom ~y1031) so caption geometry ≈ vito's bottom:4%.
      html = replaceOnce(
        html,
        'var BASE_FONT_SIZE = 72;',
        'var BASE_FONT_SIZE = 46;',
        'base font size'
      )
      html = replaceOnce(
        html,
        'var MIN_FONT_SIZE = 52;',
        'var MIN_FONT_SIZE = 34;',
        'min font size'
      )
      html = replaceOnce(html, 'font-size: 72px;', 'font-size: 46px;', 'copy font-size')
      html = replaceOnce(
        html,
        'bottom: 100px;',
        'bottom: 24px;',
        'safe-zone bottom (hug lower edge, ~vito bottom:4%)'
      )
      html = replaceAll(html, 'height: 220px;', 'height: 120px;', 'safe-zone/group box height')

      // (12) inline tokens.css + the .is-active rule, before the skin's <style>.
      const headInject = `<style data-brand-tokens>
${tokensCss.trim()}
    </style>
    <style>
      /* karaoke active word — brand ink, set via .is-active class flip */
      .caption-word.is-active { color: var(--ink); }
    </style>
    <style>`
      html = replaceOnce(html, '    <style>', `    ${headInject}`, 'inline brand tokens')
    } else if (winner === 'caption-highlight') {
      // ---------- §c2: transform caption-highlight ----------
      // highlight's build/timeline loops consume a FLAT global WORDS array + a GROUPS
      // list of {wordStart,wordEnd,start,end} index ranges (word el id = wordStart+i).
      // Rebuilding both from the engine's groups replaces (a) the demo TRANSCRIPT and
      // (b) the index-pinned RAW_GROUPS map keyed to it — so the skin renders real,
      // scene-aware, non-overlapping captions instead of its hardcoded placeholder.
      const flatWords = []
      const hlGroups = []
      for (const g of groups) {
        const wordStart = flatWords.length
        for (const w of g.words || []) {
          flatWords.push({ text: String(w.text), start: Number(w.start), end: Number(w.end) })
        }
        const wordEnd = flatWords.length - 1
        if (wordEnd < wordStart) continue // defensive: skip an empty group
        hlGroups.push({ wordStart, wordEnd, start: Number(g.start), end: Number(g.end) })
      }
      const flatWordsJson = JSON.stringify(flatWords)
      const hlGroupsJson = JSON.stringify(hlGroups)

      // (1) strip Google Fonts <link> tags (brand @font-face comes from index.html).
      {
        let removed = 0
        html = html.replace(/\s*<link\b[^>]*?>/gi, (m) => {
          if (/fonts\.g(oogleapis|static)/i.test(m)) {
            removed++
            return ''
          }
          return m
        })
        if (removed === 0) die(`transform "strip google fonts": no font <link> found`)
      }

      // (2) strip the dead #hl-video CSS rule (highlight ships no <video> element).
      html = replaceOnce(html, /\s*#hl-video\s*\{[^}]*\}/, '', 'strip dead #hl-video rule')

      // (3) host root: rename composition id + set real duration.
      html = replaceOnce(
        html,
        'data-composition-id="caption-highlight"',
        'data-composition-id="captions"',
        'host composition-id'
      )
      html = replaceOnce(
        html,
        'data-duration="8"',
        `data-duration="${totalDuration}"`,
        'host data-duration'
      )

      // (4) measurement base size 80→46 + measure font → brand display family
      //     (canvas font can't be a CSS var(); the visible font uses var(--font-display)).
      html = replaceOnce(
        html,
        'fitFontSize(groupText, 80, "800", "Montserrat", 1620)',
        `fitFontSize(groupText, 46, "800", ${JSON.stringify(brandDisplay)}, 1620)`,
        'fit base size + measure font'
      )

      // (5) kill the placeholder transcript → engine flat words.
      html = replaceOnce(
        html,
        /var WORDS = \[[\s\S]*?\];/,
        `var WORDS = ${flatWordsJson};`,
        'WORDS placeholder'
      )

      // (6) drop the index-pinned RAW_GROUPS + its derived GROUPS map → engine groups
      //     (scene-aware, non-overlapping). Fixes the same class of blocker as clip-wipe.
      html = replaceOnce(
        html,
        /var RAW_GROUPS = \[[\s\S]*?\}\);/,
        `var GROUPS = ${hlGroupsJson};`,
        'engine groups'
      )

      // (7) add the canonical .caption-group/.caption-word classes alongside the skin's
      //     own (.hl-group/.hl-word) so Studio + captionOverrides can detect captions.
      html = replaceOnce(
        html,
        'grp.className = "hl-group";',
        'grp.className = "hl-group caption-group";',
        'group canonical class'
      )
      html = replaceOnce(
        html,
        'wordEl.className = "hl-word";',
        'wordEl.className = "hl-word caption-word";',
        'word canonical class'
      )

      // (8) full-span timeline anchor + rename the registry key → "captions".
      html = replaceOnce(
        html,
        'window.__timelines["caption-highlight"] = tl;',
        `tl.to({}, { duration: ${totalDuration} }, 0);\n        window.__timelines["captions"] = tl;`,
        'timeline key + anchor'
      )

      // (9) geometry → shrink into the lower-third keep-out band (~vito bottom band).
      //     80px uppercase at bottom:140px would top out ~y845, ABOVE the reserved
      //     ~180px band (y900-1080); 46px at bottom:36px keeps 1-2 lines inside it.
      html = replaceOnce(html, 'font-size: 80px;', 'font-size: 46px;', 'word font-size')
      html = replaceOnce(html, 'bottom: 140px;', 'bottom: 36px;', 'group bottom (hug lower edge)')

      // (10) tokenize CSS colors/fonts → brand-strict.
      html = replaceOnce(
        html,
        'font-family: "Montserrat", sans-serif;',
        'font-family: var(--font-display), sans-serif;',
        'font-family token'
      )
      html = replaceOnce(html, 'color: #ffffff;', 'color: var(--canvas);', 'word color token')
      // ADAPTIVE CONTRAST: the active word sits on a var(--brand-primary) fill whose
      // lightness is unknown at build time, so NO single text color is safe on it
      // (canvas fails on a light primary, ink fails on a dark one). Give the glyphs a
      // crisp var(--ink) OUTLINE (8-way) so the canvas-filled text reads on any brand
      // fill — light or dark — plus a soft ink drop for depth. Legibility no longer
      // depends on the primary's luminance; it rides the guaranteed canvas↔ink pair.
      html = replaceOnce(
        html,
        'text-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);',
        'text-shadow: 2px 0 0 var(--ink), -2px 0 0 var(--ink), 0 2px 0 var(--ink), 0 -2px 0 var(--ink), 1.5px 1.5px 0 var(--ink), -1.5px 1.5px 0 var(--ink), 1.5px -1.5px 0 var(--ink), -1.5px -1.5px 0 var(--ink), 0 4px 12px color-mix(in srgb, var(--ink) 40%, transparent);',
        'ink-outline text (adaptive contrast on any brand fill)'
      )
      html = replaceOnce(
        html,
        'background: linear-gradient(135deg, #ff1745 0%, #df1238 100%);',
        'background: linear-gradient(135deg, var(--brand-primary) 0%, color-mix(in srgb, var(--brand-primary) 85%, var(--ink)) 100%);',
        'highlight bg token'
      )
      html = replaceOnce(
        html,
        'box-shadow: 0 12px 30px rgba(229, 20, 58, 0.32);',
        'box-shadow: 0 12px 30px color-mix(in srgb, var(--brand-primary) 32%, transparent);',
        'highlight shadow token'
      )

      // (11) scrim band — highlight is transparent, so its full-screen first-child
      //      .hl-overlay (z-index 1, below the words at z-index 10) becomes a
      //      brand-strict lower-third gradient so text reads over any scene (guide §3).
      html = replaceOnce(
        html,
        `      .hl-overlay {
        position: absolute;
        inset: 0;
        background: transparent;
        z-index: 1;
        pointer-events: none;
      }`,
        `      .hl-overlay {
        position: absolute;
        inset: 0;
        background: linear-gradient(
          to top,
          color-mix(in srgb, var(--ink) 82%, transparent) 0%,
          color-mix(in srgb, var(--ink) 55%, transparent) 12%,
          transparent 26%
        );
        z-index: 1;
        pointer-events: none;
      }`,
        'scrim band'
      )

      // (12) inline tokens.css before the skin's <style>.
      const headInject = `<style data-brand-tokens>
${tokensCss.trim()}
    </style>
    <style>`
      html = replaceOnce(html, '    <style>', `    ${headInject}`, 'inline brand tokens')
    } else {
      die(`internal: no transform implemented for ${winner}`)
    }
  } // end else: registry-skin path (preset-local path handled above)

  // ---------- §d: node structural self-lint ----------
  function lint(cond, msg) {
    if (!cond) die(`self-lint: ${msg}`)
  }
  // common (every skin): canonical hooks, real duration, no leaks/footguns.
  lint(html.includes('data-composition-id="captions"'), 'missing data-composition-id="captions"')
  lint(html.includes('window.__timelines["captions"]'), 'missing window.__timelines["captions"]')
  lint(
    /class="caption-group/.test(html) || html.includes('caption-group'),
    'missing .caption-group'
  )
  lint(html.includes('caption-word'), 'missing .caption-word')
  lint(!html.includes('Every great video starts'), 'placeholder transcript text still present')
  lint(!/fonts\.g(oogleapis|static)/i.test(html), 'Google Fonts link still present')
  lint(
    !/window\.(getComputedStyle|requestAnimationFrame|matchMedia)\(/.test(html),
    'render-time Illegal-invocation footgun (window.<native>())'
  )
  lint(
    html.includes(`data-duration="${totalDuration}"`),
    'host data-duration not rewritten to total'
  )
  // skin-specific structural gates.
  if (winner === 'caption-pill-karaoke') {
    lint(!/id="avatar-video"/.test(html), 'demo <video> still present')
    lint(
      html.includes(`var DURATION = ${totalDuration};`),
      'DURATION not rewritten to total_duration_s'
    )
  } else if (winner === 'caption-highlight') {
    lint(
      !html.includes('var RAW_GROUPS'),
      'index-pinned RAW_GROUPS not replaced with engine groups'
    )
    lint(!/<video\b/i.test(html), 'unexpected <video> element')
    lint(
      html.includes(`tl.to({}, { duration: ${totalDuration} }, 0);`),
      'full-span timeline anchor missing'
    )
  }
  // brand-strict: strip the brand-token block, then no bare hex / rgb(a).
  {
    const stripped = html.replace(/<style data-brand-tokens>[\s\S]*?<\/style>/g, '')
    const bareHex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || []
    const bareRgb = stripped.match(/\brgba?\(/g) || []
    if (bareHex.length || bareRgb.length) {
      die(
        `self-lint: brand-strict violation (bare color outside token block): ${[...bareHex, ...bareRgb].slice(0, 6).join(', ')}`
      )
    }
  }

  // Brand tokens are now declared once globally in index.html's <head> (by
  // assemble-index.mjs) and inherit into captions.html when it mounts as a
  // sub-composition, so the inlined per-file <style data-brand-tokens> block is
  // redundant — strip it. The brand-strict self-lint above already validated all
  // colors against it; FONT_FAMILY for canvas text-measure is a separate JS
  // string set above, unaffected. (Standalone Studio preview re-injects
  // index.html's <head>, so tokens still resolve there too.)
  html = html.replace(/[ \t]*<style data-brand-tokens>[\s\S]*?<\/style>\s*\n?/g, '')

  // ---------- write ----------
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, html)

  // ---------- summary ----------
  const wordCount = groups.reduce((n, g) => n + (g.words ? g.words.length : 0), 0)
  const ownBg = usePresetSkin ? true : SKINS[winner]?.has_own_bg
  console.log(`✓ wrote ${outPath}`)
  if (usePresetSkin) {
    console.log(`  skin:     ${winner} (preset-local → chunks/caption-skin.html)`)
  } else {
    console.log(
      `  skin:     ${winner}${forcedSkin ? ' (forced)' : ''}${skinFile ? ' (from --skin-file)' : ''}`
    )
  }
  console.log(`  groups:   ${groups.length}  words: ${wordCount}  duration: ${totalDuration}s`)
  console.log(
    `  readability: ${ownBg ? 'own opaque pill (no scrim needed)' : 'brand-strict lower-third scrim band'}; colors brand-token driven`
  )
  console.log(`  self-lint: OK`)
}

// =====================================================================
// keepout  — was check-caption-keepout.mjs
// =====================================================================
// check-caption-keepout.mjs — static gate for caption keep-out compliance.
//
// When captions are enabled (group_spec.captions_enabled === true), index.html's
// track-12 caption pill overlays the bottom ~17% of the 1080px canvas (y > 900).
// Foreground scene content placed there (chips / CTAs / hero text / stats / cards)
// gets visually covered by the karaoke pill at render time.
//
// The principle this script enforces:
//     For every absolutely-positioned FOREGROUND element, its rendered bottom
//     edge must end at y ≤ 900 (= 20px above the y=900 caption band edge).
//
// The same principle has multiple CSS shapes — this script catches the three
// statically detectable ones. For each rule with `position: absolute` and a
// non-decoration leaf selector, it computes the element's bottom-edge y and
// flags any rule where that y > 900:
//
//   (A) `bottom: <X>px` with X < 180
//         element bottom y = 1080 - X > 900
//   (B) `top: <X>px` with X >= 900
//         element top alone is already inside the caption band (any non-zero
//         height pushes it deeper)
//   (C) `top: <X>px` AND `height: <Y>px` with X + Y > 900
//         explicit top+height pair lets us compute element bottom exactly
//
// The bbox math is transform-aware (translate / translateY / translate3d with
// px / % literals) AND margin-aware (longhand margin-top / margin-bottom plus
// the px-literal `margin:` shorthand) — for absolutely positioned elements the
// inset places the MARGIN box, so e.g. the negative-margin centering trick
// (`top: 620px; height: 340px; margin-top: -170px` → real bottom 790, naive
// sum 960) must fold the margin in or it false-positives. Rules whose
// transform / Y margin cannot be statically resolved (matrix, calc(), var(),
// auto, %) are conservatively SKIPPED. Only runtime GSAP positioning remains
// undetectable here — that falls through to the finalize agent's snapshot
// eye-check (covered by a fallback row in the finalize agent's
// "phenomenon → root cause" table).
//
// Decoration exemption: any selector whose leaf class/id name matches the
// DECORATION_NAME_RX list (bg / dot-grid / surface / corner-pin / star-burst
// / ambient / glow / frame / etc.) is allowed in the caption band — those
// are full-bleed background or decorative layers, not foreground content.
// Pseudo-elements (`::before` / `::after` / etc.) are always exempt.
//
// Each violation carries the EXACT `edit_old` / `edit_new` strings that the
// finalize agent feeds into the Edit tool. No Read, no math, no search by
// the agent — the brief tells it exactly which file, which substring to
// replace, and what to replace it with. Worst case: 1 Edit call per
// violation.
//
// CLI usage:
//   node captions.mjs keepout --group-spec ./group_spec.json --hyperframes . [--json] [--scene <sid>[,<sid>]]
//
// preflight-finalize.mjs consumes the gate by spawning `keepout --json` and
// parsing the result object off stdout (out-of-process — no ESM import of this
// file's CLI dispatcher).
//
// Exit codes (CLI): 0 = captions disabled or no violations, 1 = violations.
async function runKeepout(argv) {
  // ---------- constants (canvas-relative; recomputed from group_spec.height in
  // runCli before the check runs — these are the landscape defaults / fallback) ----------
  let CANVAS_HEIGHT_PX = 1080
  let CAPTION_BAND_TOP_Y = 900 // foreground must end at or above this y
  let FAIL_THRESHOLD_BOTTOM_PX = 180 // any `bottom:` strictly less than this is suspect (= band height)
  let SUGGESTED_MIN_BOTTOM_PX = 200 // safe blanket — element bottom lands 20px above the band
  // Geometry note: with `position: absolute; bottom: <SUGGESTED_MIN>px;` the
  // element's bottom edge is at y = H − SUGGESTED_MIN = CAPTION_BAND_TOP_Y − 20,
  // i.e. 20px above the band edge. Holds for any canvas height — the constraint
  // is "where does the element END", not "where does it start". Landscape:
  // H=1080, band top y=900, min bottom 200. Portrait: H=1920, band top y=1600,
  // min bottom 340.

  // Decoration / background name patterns. Selectors whose LEAF class/id name
  // matches any of these are skipped — they're allowed to extend full-bleed
  // into the caption band (backgrounds, surface decorations, corner frames,
  // ambient layers, decorative shapes, hidden measurement probes, etc.).
  // Match against the leaf token after `.` or `#`, with `-` / `_` as token boundaries.
  const DECORATION_NAME_RX =
    /(?:^|[-_])(?:bg|background|dot-?grid|mesh|gradient|swell|ambient|texture|noise|scanline|surface|overlay|halo|glow|frame|pin|corner-?pin|deco|star-?burst|burst|ring|stripe|rect|shadow|pulse|ripple|measure|probe|hidden|scrim|backdrop|veil|fog|grain)(?:[-_]|$)/i

  // CSS pseudo-elements: always allowed (inherently decoration).
  const PSEUDO_RX =
    /::(?:before|after|backdrop|placeholder|selection|first-letter|first-line|marker)/i

  // ---------- main check (exported) ----------
  // sceneFilter: optional array of scene_ids — non-empty limits the scan to
  // those scenes (worker self-check scopes to its own 1-2 scenes; preflight
  // passes nothing and scans everything). A filter id matches a visual target
  // when it equals the visual id (group_wN) OR any of its logical scene_ids.
  function checkCaptionKeepout({ groupSpec, hyperframesDir, sceneFilter = [] }) {
    const captionsEnabled = groupSpec?.captions_enabled === true
    const baseResult = {
      enabled: captionsEnabled,
      canvas_height_px: CANVAS_HEIGHT_PX,
      caption_band_top_y: CAPTION_BAND_TOP_Y,
      fail_threshold_bottom_px: FAIL_THRESHOLD_BOTTOM_PX,
      suggested_min_bottom_px: SUGGESTED_MIN_BOTTOM_PX,
      scenes_scanned: 0,
      violations: []
    }
    if (!captionsEnabled) return baseResult

    const groups = Array.isArray(groupSpec.groups) ? groupSpec.groups : []
    const sceneIds = groups.flatMap((g) => (Array.isArray(g.scene_ids) ? g.scene_ids : []))
    let visualTargets =
      Array.isArray(groupSpec.visual_clips) && groupSpec.visual_clips.length > 0
        ? groupSpec.visual_clips.map((v) => ({
            id: String(v.id || ''),
            file: String(v.file || `compositions/${v.id}.html`),
            sceneIds: Array.isArray(v.scene_ids) ? v.scene_ids : []
          }))
        : sceneIds.map((sid) => ({
            id: sid,
            file: `compositions/${sid}.html`,
            sceneIds: [sid]
          }))
    if (sceneFilter.length) {
      visualTargets = visualTargets.filter(
        (v) => sceneFilter.includes(v.id) || v.sceneIds.some((sid) => sceneFilter.includes(sid))
      )
    }

    let scannedCount = 0
    const violations = []

    for (const visual of visualTargets) {
      const file = join(hyperframesDir, visual.file)
      if (!existsSync(file)) continue
      scannedCount++
      const html = readFileSync(file, 'utf8')
      const found = scanSceneHtml(html, visual.id)
      for (const v of found) {
        v.file = visual.file
        v.visual_id = visual.id
        v.logical_scene_ids = visual.sceneIds
        v.instruction = v.instruction.replace(`compositions/${visual.id}.html`, visual.file)
        violations.push(v)
      }
    }

    return { ...baseResult, scenes_scanned: scannedCount, violations }
  }

  // ---------- per-scene scanner ----------
  function scanSceneHtml(html, sceneId) {
    // 1. Concatenate all <style> contents, strip /* ... */ comments.
    const styleBlocks = []
    const styleRx = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
    let sm
    while ((sm = styleRx.exec(html)) !== null) styleBlocks.push(sm[1])
    if (styleBlocks.length === 0) return []
    const css = styleBlocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, '')

    // 2. Walk top-level CSS rules `selector { body }` (no nesting). Body must
    //    not contain braces — rules out @media / @keyframes / nested-rules.
    const ruleRx = /([^{}]+)\{([^{}]*)\}/g
    const violations = []
    let m
    while ((m = ruleRx.exec(css)) !== null) {
      const selectorBlock = m[1].trim()
      if (!selectorBlock || selectorBlock.startsWith('@')) continue
      const body = m[2]

      // 3. Must be absolutely positioned.
      if (!/(?:^|[;\s{])position\s*:\s*absolute\b/i.test(body)) continue

      // 4. Detect which CSS shape (if any) puts the element bottom into y > 900.
      //    Three independently-detectable patterns; a single rule can hit more
      //    than one (e.g. both `bottom:` AND `top:` — common for stretched bands).
      //
      //    Property regex anchors at start-of-property to avoid matching
      //    `border-bottom`, `margin-bottom`, `padding-bottom`, `border-top`, etc.
      const propPx = (name) => {
        const m = body.match(
          new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px\\s*;`, 'i')
        )
        return m ? { raw: m[1], val: parseFloat(m[1]) } : null
      }
      const bottom = propPx('bottom')
      const top = propPx('top')
      const height = propPx('height')

      // 4a. Transform-aware Y offset.
      //    `transform: translate(-50%, -50%)` (centering trick) shifts the element
      //    upward by half its height — without accounting for it, a card visually
      //    centered in the upper canvas can be falsely flagged as overflowing the
      //    caption band. Parses translateY / translate / translate3d Y-component
      //    and returns:
      //      - `{ frac, knownPx }` where frac is the Y translate as a fraction
      //        of element height (e.g. -0.5 for translate(-50%, -50%)), and
      //        knownPx is a literal px offset when the transform was authored in
      //        px (overrides frac).
      //      - null when the transform contains a Y component but we cannot
      //        statically resolve it (matrix, calc(), CSS variable). The caller
      //        falls back to "skip violation" because firing when we can't tell
      //        is the path that led to the bad-Edit incident.
      //    Returns `{ frac: 0, knownPx: 0 }` when there is no transform or it
      //    has no Y component — the simple case, fully equivalent to the old
      //    behaviour.
      const parseTransformY = () => {
        const tm = body.match(/(?:^|[;{\s])transform\s*:\s*([^;]+);/i)
        if (!tm) return { frac: 0, knownPx: 0 }
        const tx = tm[1].trim()
        // matrix / calc / var → can't statically resolve → caller skips.
        if (/\b(?:matrix3?d?|calc\(|var\()/i.test(tx)) return null
        // First scan for a Y-affecting translate; only the first one is parsed
        // here (composition of multiple translates is rare in PLV scenes).
        let m
        if ((m = tx.match(/\btranslateY\(\s*(-?\d+(?:\.\d+)?)(%|px)\s*\)/i))) {
          const val = parseFloat(m[1])
          return m[2] === '%' ? { frac: val / 100, knownPx: 0 } : { frac: 0, knownPx: val }
        }
        if ((m = tx.match(/\btranslate3d\(\s*[^,)]+,\s*(-?\d+(?:\.\d+)?)(%|px)\s*,/i))) {
          const val = parseFloat(m[1])
          return m[2] === '%' ? { frac: val / 100, knownPx: 0 } : { frac: 0, knownPx: val }
        }
        if ((m = tx.match(/\btranslate\(\s*[^,)]+,\s*(-?\d+(?:\.\d+)?)(%|px)\s*\)/i))) {
          const val = parseFloat(m[1])
          return m[2] === '%' ? { frac: val / 100, knownPx: 0 } : { frac: 0, knownPx: val }
        }
        // translate(x) with only one arg → Y is 0; translateX(…) → Y is 0.
        return { frac: 0, knownPx: 0 }
      }
      const transformY = parseTransformY()
      // Unresolvable transform → conservative skip (don't false-positive).
      if (transformY === null) continue

      // 4a-bis. Margin-aware Y offset.
      //    For absolutely positioned elements the inset properties place the
      //    MARGIN box, so the border box shifts by the margin: with `top:`,
      //    visualTop = top + margin-top; with `bottom:`, visualBottom =
      //    H − bottom − margin-bottom. The negative-margin centering trick
      //    (`top: 620px; height: 340px; margin-top: -170px` → real bottom
      //    790) false-positives without this fold — a measured session
      //    burned a repair round on exactly that. Longhand wins when both
      //    longhand and shorthand are present (close enough to cascade
      //    order for hand-authored scene CSS). Any Y component we cannot
      //    statically resolve (auto / % / calc / var) → null → the caller
      //    skips the rule, same rationale as unresolvable transforms.
      const parseMarginY = () => {
        const mt = propPx('margin-top')
        const mb = propPx('margin-bottom')
        let shTop = null
        let shBottom = null
        const sh = body.match(/(?:^|[;{\s])margin\s*:\s*([^;]+);/i)
        if (sh) {
          const parts = sh[1].trim().split(/\s+/)
          // `auto` Y margin on an absolute element resolves to 0 unless BOTH
          // top and bottom insets are set (the over-constrained centering
          // case) — only then is it unresolvable statically.
          const autoResolvable = !(top && bottom)
          const px = (s) => {
            if (s === '0') return 0
            if (/^auto$/i.test(s)) return autoResolvable ? 0 : null
            const m = s.match(/^(-?\d+(?:\.\d+)?)px$/i)
            return m ? parseFloat(m[1]) : null
          }
          // 1-4 value shorthand: Y components are parts[0] (top) and
          // parts[2] when present (bottom), else parts[0] again.
          shTop = px(parts[0])
          shBottom = px(parts.length >= 3 ? parts[2] : parts[0])
          // Shorthand present but its Y components unresolvable, and no
          // longhand override for that side → cannot tell → skip rule.
          if ((shTop === null && !mt) || (shBottom === null && !mb)) return null
        }
        return {
          top: mt ? mt.val : (shTop ?? 0),
          bottom: mb ? mb.val : (shBottom ?? 0)
        }
      }
      const marginY = parseMarginY()
      if (marginY === null) continue

      // Compute the element's visual bottom y AFTER applying the transform. The
      // shift in px = height × frac + knownPx; for frac to be applied we need
      // the element height. When `height` is missing AND frac ≠ 0, we don't
      // know the real shift → conservative skip (matches the unresolvable case).
      const transformShiftPx = (h) =>
        h !== null
          ? h * transformY.frac + transformY.knownPx
          : transformY.frac !== 0
            ? null
            : transformY.knownPx

      // Pattern A: `bottom: <X>px` with X < 180  →  element bottom y > 900.
      //    Transform + margin adjust the visual bottom:
      //    visualBottom = (H − X) − margin-bottom + shift.
      //    If shift is unresolvable but transform has a % component, conservative skip.
      let hitsA = false
      let aVisualBottom = null
      if (bottom && Number.isFinite(bottom.val)) {
        const shift = transformShiftPx(height ? height.val : null)
        if (shift === null) {
          // can't resolve shift; if there's no transform we already get 0; only here
          // when transform has %-Y but no height — conservative skip.
          /* skip pattern A */
        } else {
          aVisualBottom = CANVAS_HEIGHT_PX - bottom.val - marginY.bottom + shift
          hitsA = bottom.val < FAIL_THRESHOLD_BOTTOM_PX && aVisualBottom > CAPTION_BAND_TOP_Y
        }
      }
      // Pattern B: `top: <X>px` with X >= 900    →  element top inside caption band.
      //    Transform + margin adjust the visual top: visualTop = X + margin-top + shift.
      //    When shift is unresolvable, conservative skip.
      let hitsB = false
      let bVisualTop = null
      if (top && Number.isFinite(top.val)) {
        const shift = transformShiftPx(height ? height.val : null)
        if (shift === null) {
          /* skip pattern B — would need height to resolve % shift */
        } else {
          bVisualTop = top.val + marginY.top + shift
          hitsB = bVisualTop >= CAPTION_BAND_TOP_Y
        }
      }
      // Pattern C: `top + height` with bottom edge > 900 (transform- and margin-aware).
      //    visualBottom = top + margin-top + height + shift; shift uses the same
      //    height we already know, so it is always resolvable here.
      //    (Skipped when pattern A is already hitting on the same rule — we don't
      //    want to double-fire on `top: 80; bottom: 120; height: ignored`.)
      let hitsC = false
      let cVisualBottom = null
      if (!hitsA && top && height && Number.isFinite(top.val) && Number.isFinite(height.val)) {
        const shift = transformShiftPx(height.val)
        cVisualBottom = top.val + marginY.top + height.val + shift
        hitsC = cVisualBottom > CAPTION_BAND_TOP_Y
      }

      if (!hitsA && !hitsB && !hitsC) continue

      // 5. Split comma-separated selectors. Check each leaf independently.
      const selectors = selectorBlock
        .split(/,(?![^()]*\))/g)
        .map((s) => s.trim())
        .filter(Boolean)

      for (const sel of selectors) {
        if (PSEUDO_RX.test(sel)) continue
        const nameMatches = [...sel.matchAll(/[#.]([\w-]+)/g)]
        if (nameMatches.length === 0) continue
        const leaf = nameMatches[nameMatches.length - 1][1]
        if (DECORATION_NAME_RX.test(leaf)) continue

        // Pick the most reliable pattern to report (prefer A > C > B because A/C
        // pin the element bottom y exactly, B only the top y).
        //
        // Transform-aware math: the *VisualBottom / *VisualTop computed above
        // already account for `transform: translate*` Y components. The
        // suggested Edit values below derive their target so that, AFTER
        // applying the same transform, the element bottom lands at
        // y ≤ CAPTION_BAND_TOP_Y - 20 (= 880; 20px safety clearance).
        let pattern, oldStr, newStr, elementBottomY, overlapPx, principle
        const offsetNotes = []
        if (transformY.frac !== 0 || transformY.knownPx !== 0)
          offsetNotes.push(
            `transform Y shift ${(transformY.frac * 100).toFixed(0)}% + ${transformY.knownPx}px`
          )
        if (marginY.top !== 0 || marginY.bottom !== 0)
          offsetNotes.push(`margin Y ${marginY.top}px / ${marginY.bottom}px`)
        const transformNote = offsetNotes.length ? ` (with ${offsetNotes.join(', ')})` : ''
        if (hitsA) {
          pattern = 'bottom-too-small'
          elementBottomY = Math.round(aVisualBottom)
          overlapPx = elementBottomY - CAPTION_BAND_TOP_Y
          // visual_bottom = (H - bottom) - margin-bottom + shift; target
          // visual_bottom = 880. shift = height * frac + knownPx; height is
          // whatever the rule has today; so target bottom =
          // H - 880 - margin-bottom + shift (shift and margin are signed).
          const shift = transformShiftPx(height ? height.val : 0) || 0
          const targetBottom = Math.max(
            0,
            CANVAS_HEIGHT_PX - (CAPTION_BAND_TOP_Y - 20) - marginY.bottom + shift
          )
          oldStr = `bottom: ${bottom.raw}px;`
          newStr = `bottom: ${targetBottom}px;`
          principle = `visual bottom y = ${elementBottomY} > 900${transformNote}`
        } else if (hitsC) {
          pattern = 'top-plus-height-too-tall'
          elementBottomY = Math.round(cVisualBottom)
          overlapPx = elementBottomY - CAPTION_BAND_TOP_Y
          // visual_bottom = top + margin-top + height + shift; shift depends on
          // height when frac != 0. Solve for new height H' so visual_bottom = 880:
          //   top + marginTop + H' + H'*frac + knownPx = 880
          //   H' = (880 - top - marginTop - knownPx) / (1 + frac)
          // For frac > -1 (which covers `translate(*, -50%)` and the vast
          // majority of layouts); otherwise fall back to the non-transform formula.
          const denom = 1 + transformY.frac
          const suggestedHeight =
            denom > 0
              ? Math.max(
                  0,
                  Math.floor(
                    (CAPTION_BAND_TOP_Y - 20 - top.val - marginY.top - transformY.knownPx) / denom
                  )
                )
              : Math.max(0, CAPTION_BAND_TOP_Y - 20 - top.val - marginY.top)
          oldStr = `height: ${height.raw}px;`
          newStr = `height: ${suggestedHeight}px;`
          principle = `top(${top.val}) + height(${height.val}) + offsets → visual bottom y = ${elementBottomY} > 900${transformNote}`
        } else {
          // hitsB
          pattern = 'top-in-caption-band'
          elementBottomY = Math.round(bVisualTop) // we only know top — bottom is at least this
          overlapPx = elementBottomY - CAPTION_BAND_TOP_Y
          // visual_top = top + margin-top + shift; target visual_top = 820.
          // shift is the same regardless of top, so: new_top = 820 - marginTop - shift.
          const shift = transformShiftPx(height ? height.val : 0) || 0
          const suggestedTop = Math.max(0, CAPTION_BAND_TOP_Y - 80 - marginY.top - shift)
          oldStr = `top: ${top.raw}px;`
          newStr = `top: ${suggestedTop}px;`
          principle = `visual top y = ${elementBottomY} >= 900${transformNote}`
        }

        const oldUniqueInFile = countOccurrences(html, oldStr) === 1

        violations.push({
          scene_id: sceneId,
          selector: sel,
          leaf_name: leaf,
          pattern,
          principle,
          element_bottom_y: elementBottomY,
          overlap_into_caption_band_px: overlapPx,
          current_bottom_px: hitsA ? bottom.val : null,
          current_top_px: top ? top.val : null,
          current_height_px: height ? height.val : null,
          suggested_min_bottom_px: SUGGESTED_MIN_BOTTOM_PX, // for context only
          edit_old: oldStr,
          edit_new: newStr,
          edit_old_is_unique: oldUniqueInFile,
          instruction:
            `Edit compositions/${sceneId}.html: in the \`${sel}\` rule ` +
            `(it has \`position: absolute\`), replace \`${oldStr}\` with \`${newStr}\`. ` +
            (oldUniqueInFile
              ? `(The string \`${oldStr}\` is unique in this file — single Edit call with no extra context needed.)`
              : `(The string \`${oldStr}\` appears multiple times in this file — wrap your Edit's old_string with the line above it for uniqueness, e.g. include the line \`.${leaf} {\` or one of the adjacent property lines.)`) +
            ` Principle: ${principle} (caption band starts at y=${CAPTION_BAND_TOP_Y}, foreground element bottom must be ≤ y=${CAPTION_BAND_TOP_Y - 20} with 20px clearance).`
        })
      }
    }
    return violations
  }

  function countOccurrences(haystack, needle) {
    if (!needle) return 0
    let n = 0,
      i = 0
    while ((i = haystack.indexOf(needle, i)) !== -1) {
      n++
      i += needle.length
    }
    return n
  }

  // ---------- CLI ----------
  function runCli() {
    const flag = (n, d) => {
      const i = argv.indexOf(`--${n}`)
      return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
    }
    const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
    const hyperframesDir = resolve(flag('hyperframes', '.'))
    const asJson = argv.includes('--json')
    const sceneFilter = (flag('scene', '') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    if (!existsSync(groupSpecPath)) {
      console.error(`✗ check-caption-keepout: group_spec.json missing at ${groupSpecPath}`)
      process.exit(2)
    }
    const groupSpec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
    // Recompute the band geometry for this canvas (portrait/square shift it down).
    {
      const { height: H } = readDims(groupSpec)
      const { bandHeight, bandTopY } = captionBand(H, 20)
      CANVAS_HEIGHT_PX = H
      CAPTION_BAND_TOP_Y = bandTopY
      FAIL_THRESHOLD_BOTTOM_PX = bandHeight
      SUGGESTED_MIN_BOTTOM_PX = bandHeight + 20
    }
    const result = checkCaptionKeepout({ groupSpec, hyperframesDir, sceneFilter })

    if (asJson) {
      console.log(JSON.stringify(result, null, 2))
      process.exit(result.violations.length === 0 ? 0 : 1)
    }

    if (!result.enabled) {
      console.log('✓ caption-keepout: captions_enabled=false, no check needed')
      process.exit(0)
    }
    if (result.violations.length === 0) {
      console.log(
        `✓ caption-keepout: ${result.scenes_scanned} scene(s) scanned, all foreground absolute-positioned elements end at or above y=${CAPTION_BAND_TOP_Y}`
      )
      process.exit(0)
    }
    const sceneCount = new Set(result.violations.map((v) => v.scene_id)).size
    console.error(
      `✗ caption-keepout: ${result.violations.length} violation(s) across ${sceneCount} scene(s) (caption band starts at y=${CAPTION_BAND_TOP_Y})`
    )
    for (const v of result.violations) {
      console.error(`\n  [${v.scene_id}] ${v.selector}  (pattern: ${v.pattern})`)
      console.error(
        `    ${v.principle} → element bottom at y=${v.element_bottom_y} (${v.overlap_into_caption_band_px}px inside caption band)`
      )
      console.error(
        `    fix: replace \`${v.edit_old}\` → \`${v.edit_new}\` in ${v.file} ${v.edit_old_is_unique ? '(old string unique — Edit safely)' : '(old string non-unique — wrap with selector line)'}`
      )
    }
    console.error(
      `\n  → finalize_brief.json.caption_keepout.violations carries identical findings + Edit-ready strings. Finalize agent patches in-place with N Edit calls, no Read/search needed.`
    )
    process.exit(1)
  }

  // Was: `if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) runCli();`
  // Per merge mechanism, the dispatcher reaches this wrapper only for the `keepout`
  // subcommand, so the inner entry call runs unconditionally.
  runCli()
}

// =====================================================================
// dispatcher
// =====================================================================
const sub = process.argv[2]
const rest = process.argv.slice(3)
switch (sub) {
  case 'group':
    await runGroup(rest)
    break
  case 'html':
    await runHtml(rest)
    break
  case 'keepout':
    await runKeepout(rest)
    break
  default:
    console.error('usage: node captions.mjs <group|html|keepout> [args...]')
    process.exit(2)
}
