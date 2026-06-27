#!/usr/bin/env node
// Phase 4a — prep + group plan (deterministic; no subagent).
//
// Reads:  section_plan.md (Phase 3), narrator_scripts.json (Phase 2),
//         audio_meta.json (Phase 2.5, optional), capture/assets/ (Phase 1 —
//         hyperframes capture), design-system/fonts/ (Phase 1b, populated by
//         build-design.mjs from capture's font binaries),
//         hyperframes-animation/rules/*.md (existence only).
// Writes: public/<assets>, public/fonts/<woff2>, ./group_spec.json inside the
//         HyperFrames project root passed via --hyperframes. The
//         product-launch-video orchestrator initializes that project root
//         before calling prep.
//
// This file is the ORCHESTRATOR. The deterministic concern logic lives in
// sibling lib/ modules so no single file carries every concern at once:
//   lib/prep-assets.mjs   — capture media + fonts → public/, @font-face extract (Steps 2/2b/2c)
//   lib/prep-section.mjs  — parse section_plan.md → film_direction + scenes      (Step 3)
//   lib/prep-design.mjs   — resolve design-system chunks + brand tokens           (Step 4b)
//   lib/prep-sfx.mjs      — SFX library copy + cue → global timing                (Step 6.5)
// The section_plan.md anchors recognised by the parser are documented in
// lib/prep-section.mjs. Steps 4 (rule_paths), 5 (audio-truth duration ladder),
// 6 (continuity grouping), 6.6/6.7 (visual clips + transitions) and 7/8 (emit +
// summary) stay here — they own the cap=N worker grouping that is pr-to-video's
// decoupled-continuity model.
//
// Usage:
//   node prep.mjs --section-plan <path> --narrator-scripts <path> \
//                 --rules-dir <abs> --capture <path> --hyperframes <path> \
//                 --out <path> [--audio-meta <path>] [--design-system <path>] \
//                 [--scenes-per-group <int>]
//
// Exit 0 = group_spec.json written + summary on stdout.
// Exit 1 = structural failure (missing anchor / missing rule / bad value) on stderr.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { resolveDimensions } from './lib/dimensions.mjs'
import { copyBrandFonts, copyCaptureAssets, extractFontFaceCss } from './lib/prep-assets.mjs'
import { extractBrandTokensCss, resolveDesignChunks } from './lib/prep-design.mjs'
import { die } from './lib/prep-log.mjs'
import { parseSectionPlan } from './lib/prep-section.mjs'
import { resolveSfx } from './lib/prep-sfx.mjs'
import { loadTransitionRegistry, transitionsByName } from './lib/transition-registry.mjs'

// ---------- argv ----------
const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
}
const round3 = (n) => Number(n.toFixed(3))

const sectionPlanPath = resolve(flag('section-plan', './section_plan.md'))
const narratorScriptsPath = resolve(flag('narrator-scripts', './narrator_scripts.json'))
// Default to the conventional project-root location. With NO default (the old
// behavior), a forgotten --audio-meta flag silently dropped ALL voice / words /
// bgm / caption paths → a voiceless, captionless render with every gate green.
// The guard after the scene loop also shouts if audio_meta lists voiced scenes
// but none get wired. Pass --no-audio-meta to force the no-audio path on purpose.
const audioMetaPath =
  flag('no-audio-meta') === true
    ? null
    : resolve(typeof flag('audio-meta') === 'string' ? flag('audio-meta') : './audio_meta.json')
const rulesDirArg = flag('rules-dir')
if (!rulesDirArg) die('Missing required --rules-dir')
const rulesDir = resolve(rulesDirArg)
// `--capture` is the v3 flag (hyperframes capture). `--research` kept as a
// deprecated alias to make in-flight projects upgrade cleanly. Either one
// resolves to the same on-disk root that holds the page-load artifacts that
// downstream phases reference.
const captureDir = resolve(flag('capture', flag('research', './capture')))
const designSystemDir = resolve(flag('design-system', './design-system'))
const hyperframesDir = resolve(flag('hyperframes', '.'))
const outPath = resolve(flag('out', './group_spec.json'))
const scenesPerGroupMax = parseInt(flag('scenes-per-group', '3'), 10)
// Optional — orchestrator passes <SKILL_DIR>/assets/sfx absolute path.
// If absent: SFX cues in section_plan are silently ignored.
// (Captions are written by the Phase 4a.5 captions agent, not by prep.)
const sfxLibDir = flag('sfx-lib') ? resolve(flag('sfx-lib')) : null
if (!isFinite(scenesPerGroupMax) || scenesPerGroupMax < 1) {
  die(`--scenes-per-group must be a positive integer (got "${flag('scenes-per-group')}")`)
}

// ---------- Step 1: bootstrap HyperFrames project root ----------
if (!existsSync(hyperframesDir)) {
  console.log(`HyperFrames project root missing → npx hyperframes init ${hyperframesDir}`)
  const r = spawnSync(
    'npx',
    [
      'hyperframes',
      'init',
      hyperframesDir,
      '--example',
      'blank',
      '--non-interactive',
      '--skip-skills'
    ],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) die('npx hyperframes init failed')
}

// ---------- Step 2/2b/2c: capture media + brand fonts → public/, @font-face ----------
// See lib/prep-assets.mjs. copyCaptureAssets creates public/ first, so it must
// run before copyBrandFonts (which writes public/fonts/).
const publicDir = join(hyperframesDir, 'public')
const { copied, collisions } = copyCaptureAssets(captureDir, publicDir)
const fontsCopied = copyBrandFonts(designSystemDir, publicDir)
const fontFaceCss = extractFontFaceCss(designSystemDir)

// ---------- Step 3: parse section_plan.md ----------
// See lib/prep-section.mjs (anchors, scene blocks, SFX cue parsing, film_direction).
if (!existsSync(sectionPlanPath)) die(`section_plan.md not found at ${sectionPlanPath}`)
const planText = readFileSync(sectionPlanPath, 'utf8')
const { film_direction, scenes } = parseSectionPlan(planText)

// ---------- Step 4: resolve rule_paths ----------
const ruleStatCache = new Map()
function statRule(p) {
  if (ruleStatCache.has(p)) return ruleStatCache.get(p)
  let st
  try {
    st = statSync(p)
  } catch {
    st = null
  }
  ruleStatCache.set(p, st)
  return st
}
for (const s of scenes) {
  s.rule_paths = s.effects.map((id) => {
    const p = join(rulesDir, `${id}.md`)
    const st = statRule(p)
    if (!st || !st.isFile() || st.size === 0) die(`${s.sceneId}: rule file empty or missing: ${p}`)
    return p
  })
}

// anomalies collected throughout the rest of the script (non-fatal mismatches:
// chunks missing → fallback, audio duration drift, voice file dropped, asset
// candidate not on disk, BGM still rendering). Declared up-front so Step 4b
// can append to it.
const anomalies = []

// ---------- Step 4b: resolve design_chunks + extract :root brand tokens ----------
// See lib/prep-design.mjs. resolveDesignChunks mutates scenes[].design_chunks and
// appends anomalies; chunksIndex is reused for the brand-tokens block and summary.
const { chunksIndex } = resolveDesignChunks({ designSystemDir, scenes, anomalies })
const brandTokensCss = extractBrandTokensCss(chunksIndex, designSystemDir)

// ---------- Step 5: cross-check narrator + audio merge ----------
if (!existsSync(narratorScriptsPath))
  die(`narrator_scripts.json not found at ${narratorScriptsPath}`)
const narratorScripts = JSON.parse(readFileSync(narratorScriptsPath, 'utf8'))
const narratorByNumber = new Map((narratorScripts.scenes || []).map((s) => [s.sceneNumber, s]))

// Canvas dimensions — landscape 1920×1080 unless the upstream intent layer set
// `orientation`/`dimensions` in narrator_scripts.json (or --width/--height here
// override for testing). The resolved size is stamped into group_spec.width/
// height; every downstream script + scene worker reads it from there. See the
// seam doc at scripts/lib/dimensions.mjs.
const {
  width: CANVAS_W,
  height: CANVAS_H,
  source: dimSource
} = resolveDimensions({ width: flag('width'), height: flag('height') }, narratorScripts)

let audioMeta = null
if (audioMetaPath) {
  if (existsSync(audioMetaPath)) {
    audioMeta = JSON.parse(readFileSync(audioMetaPath, 'utf8'))
  } else {
    console.log(
      `audio_meta.json not found at ${audioMetaPath} — proceeding without audio ` +
        `(VOICELESS render). If Phase 2.5 audio ran, pass --audio-meta <path>.`
    )
  }
}

// Duration truth ladder (highest → lowest):
//   audio_meta.scenes[sceneId].voiceDuration   <- measured TTS wav = TRUE TRUTH
//   section_plan.md "**Duration:** Xs"          ← plan agent decision (already
//                                                  reconciled with audio per guide)
//   narrator_scripts.json estimatedDuration    ← earliest estimate
//
// Final s.estimatedDuration_s = highest-priority source that exists.
// Mismatch anomalies surface upstream inconsistencies but do NOT block.

// ffprobe a media file's container duration in seconds (NaN on any failure).
function ffprobeDurationSeconds(absPath) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', absPath],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) return NaN
  return parseFloat((r.stdout || '').trim())
}

for (const s of scenes) {
  const planDur = s.estimatedDuration_s // value as parsed from section_plan
  const narrator = narratorByNumber.get(s.sceneNumber)
  let narratorDur = NaN
  if (narrator?.estimatedDuration != null) {
    const m = String(narrator.estimatedDuration).match(/[\d.]+/)
    narratorDur = m ? parseFloat(m[0]) : NaN
  }
  let audioDur = NaN
  let audioScene = null
  let audioDurSource = null
  if (audioMeta) {
    audioScene = audioMeta.scenes?.[s.sceneId] || null
    if (audioScene && isFinite(audioScene.voiceDuration) && audioScene.voiceDuration > 0) {
      audioDur = audioScene.voiceDuration
      audioDurSource = 'audio_meta'
    } else if (audioScene) {
      // audio_meta lists the scene but voiceDuration is missing/0 (e.g. an
      // interrupted or partially-written audio.mjs run). The TTS wav on disk is
      // still the real truth — ffprobe it before falling back to the plan
      // estimate, so a stale 0 doesn't inflate the scene into dead air (visual
      // slot far longer than the voiceover → captions vanish mid-scene).
      const voiceRel = audioScene.voicePath || `assets/voice/${s.sceneId}.wav`
      const voiceAbs = join(hyperframesDir, voiceRel)
      if (existsSync(voiceAbs)) {
        const probed = ffprobeDurationSeconds(voiceAbs)
        if (isFinite(probed) && probed > 0) {
          audioDur = probed
          audioDurSource = 'voice_probe'
          anomalies.push(
            `${s.sceneId}: audio_meta.voiceDuration missing/0 — recovered ${probed.toFixed(3)}s by ffprobing ${voiceRel} (vs section_plan ${planDur}s)`
          )
        }
      }
    }
  }

  // Pick final value by truth ladder.
  let finalDur = planDur
  let source = 'section_plan'
  if (isFinite(audioDur)) {
    finalDur = audioDur
    source = audioDurSource || 'audio_meta'
  }
  // Round to 3 decimals — naive cumulative `start_s += dur` accumulates
  // float error fast enough that lint catches it (2.24 + 6.357 = 8.597000…1
  // → overlapping_clips_same_track). Round per scene and we emit a
  // precomputed start_s below so finalize never accumulates.
  s.estimatedDuration_s = Number(finalDur.toFixed(3))

  // Anomalies: surface cross-stage inconsistencies. audio_meta is truth when
  // present; plan and narrator are estimates that may legitimately differ within
  // small tolerances (guide.md §1 lets plan agent keep narrator when audio diff
  // <10%). Report divergence but don't moralize about it.
  const pct = (a, b) => (b > 0 ? (Math.abs(a - b) / b) * 100 : 0)
  if (source === 'audio_meta') {
    if (Math.abs(audioDur - planDur) > 0.01) {
      const p = pct(audioDur, planDur).toFixed(1)
      anomalies.push(
        `${s.sceneId}: audio_meta ${audioDur}s (truth) overrides section_plan ${planDur}s (${p}% diff)`
      )
    }
    if (isFinite(narratorDur) && Math.abs(audioDur - narratorDur) / audioDur > 0.1) {
      const p = pct(audioDur, narratorDur).toFixed(1)
      anomalies.push(
        `${s.sceneId}: narrator estimate ${narratorDur}s off by ${p}% vs audio_meta ${audioDur}s (truth)`
      )
    }
  } else if (
    source === 'section_plan' &&
    isFinite(narratorDur) &&
    Math.abs(narratorDur - planDur) > 0.01
  ) {
    const p = pct(narratorDur, planDur).toFixed(1)
    anomalies.push(
      `${s.sceneId}: section_plan ${planDur}s vs narrator ${narratorDur}s (${p}% — no audio_meta available; using section_plan)`
    )
  }

  // audio merge: voice + words paths (independent of duration)
  s.voicePath = audioScene?.voicePath || ''
  s.wordsPath = audioScene?.wordsPath || ''

  // disk checks (drop missing voice/words paths to empty + record anomaly)
  if (s.voicePath && !existsSync(join(hyperframesDir, s.voicePath))) {
    anomalies.push(`${s.sceneId}: voicePath "${s.voicePath}" not on disk — dropping to ""`)
    s.voicePath = ''
  }
  if (s.wordsPath && !existsSync(join(hyperframesDir, s.wordsPath))) {
    anomalies.push(`${s.sceneId}: wordsPath "${s.wordsPath}" not on disk — dropping to ""`)
    s.wordsPath = ''
  }
  // Check assetCandidates[] — worker may reference any of them as
  // assets in the scene HTML. Missing assets caused 50s+ of finalize
  // "hunt-and-cp" debugging in past runs.
  const narratorScene = narratorByNumber.get(s.sceneNumber)
  const candidates = Array.isArray(narratorScene?.assetCandidates)
    ? narratorScene.assetCandidates
    : []
  for (const cand of candidates) {
    if (
      cand?.path &&
      typeof cand.path === 'string' &&
      cand.path.startsWith('public/') &&
      !existsSync(join(hyperframesDir, cand.path))
    ) {
      anomalies.push(
        `${s.sceneId}: assetCandidate "${cand.path}" listed in narrator_scripts.json but not in public/ — Phase 4b worker may fail`
      )
    }
  }
  s.assetCandidates = candidates
}

// ---------- Guard: audio_meta lists voiced scenes but none got wired ----------
// The #1 silent-failure mode: prep runs without audio_meta (forgotten flag, or
// the wav paths don't resolve against --hyperframes), so every voicePath drops
// to "" and the pipeline renders a SILENT video while every gate stays green.
// audio_meta is the source of truth for "voice exists"; if it lists voiced
// scenes yet we wired zero, shout loudly so it's caught before assemble/render.
if (audioMeta) {
  const metaVoiced = Object.values(audioMeta.scenes || {}).filter((v) => v && v.voicePath).length
  const wiredVoiced = scenes.filter((s) => s.voicePath).length
  if (metaVoiced > 0 && wiredVoiced === 0) {
    const banner =
      `audio_meta.json lists ${metaVoiced} voiced scene(s) but NONE were wired into group_spec ` +
      `(every voicePath dropped). The render will be SILENT. Likely causes: the wav files are not ` +
      `under --hyperframes "${hyperframesDir}", or scene ids in audio_meta don't match section_plan. ` +
      `Fix before assembling.`
    anomalies.push(banner)
    console.error(`\n${'!'.repeat(80)}\n⚠ prep.mjs CRITICAL: ${banner}\n${'!'.repeat(80)}\n`)
  }
}

// ---------- Step 6: group by continuity, cap=N ----------
const groups = []
let cur = null
// Precomputed cumulative scene start — finalize reads this verbatim instead of
// accumulating in JS, dodging FP-precision overlaps that lint catches as
// `overlapping_clips_same_track`.
let runningStart = 0
for (const s of scenes) {
  const startNew = s.continuity === 'break' || !cur || cur.scene_ids.length >= scenesPerGroupMax
  if (startNew) {
    if (cur) groups.push(cur)
    cur = {
      worker_id: `w${groups.length + 1}`,
      scene_ids: [],
      scenes: {}
    }
  }
  const start_s = Number(runningStart.toFixed(3))
  cur.scene_ids.push(s.sceneId)
  cur.scenes[s.sceneId] = {
    start_s,
    effects: s.effects,
    rule_paths: s.rule_paths,
    assetCandidates: s.assetCandidates,
    estimatedDuration_s: s.estimatedDuration_s,
    voicePath: s.voicePath,
    wordsPath: s.wordsPath,
    design_chunks: s.design_chunks,
    creative_brief: s.creative_brief
  }
  runningStart += s.estimatedDuration_s
}
if (cur) groups.push(cur)

// ---------- Step 6.6: visual clips ----------
// Logical scenes remain the timing authority for voice / captions / SFX. Visual
// clips are the top-level sub-comps mounted on track 0:
//   - single-scene worker -> compositions/scene_N.html
//   - multi-scene continue worker -> compositions/group_wN.html
// A group composition owns true shared DOM across its logical scene run.
const visual_clips = []
const scene_to_visual = {}
const internal_seams = []

for (const g of groups) {
  const firstSid = g.scene_ids[0]
  const lastSid = g.scene_ids[g.scene_ids.length - 1]
  const firstScene = g.scenes[firstSid]
  const lastScene = g.scenes[lastSid]
  const start_s = firstScene.start_s
  const end_s = round3(lastScene.start_s + lastScene.estimatedDuration_s)
  const duration_s = round3(end_s - start_s)
  const isGroupClip = g.scene_ids.length > 1
  const composition_id = isGroupClip ? `group_${g.worker_id}` : firstSid
  const composition_file = `compositions/${composition_id}.html`

  g.start_s = start_s
  g.duration_s = duration_s
  g.composition_id = composition_id
  g.composition_file = composition_file
  g.kind = isGroupClip ? 'group' : 'scene'

  for (const sid of g.scene_ids) {
    const sceneEntry = g.scenes[sid]
    sceneEntry.local_start_s = round3(sceneEntry.start_s - start_s)
    sceneEntry.visual_id = composition_id
    scene_to_visual[sid] = composition_id
  }

  for (let i = 1; i < g.scene_ids.length; i++) {
    const fromSid = g.scene_ids[i - 1]
    const toSid = g.scene_ids[i]
    internal_seams.push({
      from_scene: fromSid,
      to_scene: toSid,
      visual_id: composition_id,
      worker_id: g.worker_id,
      global_time_s: g.scenes[toSid].start_s,
      local_time_s: g.scenes[toSid].local_start_s,
      is_break: false
    })
  }

  visual_clips.push({
    id: composition_id,
    file: composition_file,
    kind: isGroupClip ? 'group' : 'scene',
    worker_id: g.worker_id,
    scene_ids: [...g.scene_ids],
    start_s,
    duration_s
  })
}

// ---------- Step 6.7: visual-clip transitions (Tier B harness) ----------
// One record per adjacent VISUAL clip boundary. Same-worker internal seams live
// inside group_wN.html and keep real shared DOM; the top-level harness does not
// inject a wrapper transition between logical scenes in the same visual clip.
// `is_break` is derived from the GROUPING (different visual_id / worker_id), not
// re-read from the plan's Continuity anchor, because the cap=N grouping is the
// authority on which scenes a single worker actually owns.
//
// Determinism: the planner optionally names a transition per scene (the ENTERING
// transition). When absent, we default-fill from the registry's rules. No agent.
const transitions = []
let txRegistry = null
let txByName = new Map()
try {
  txRegistry = loadTransitionRegistry()
  txByName = transitionsByName()
} catch (e) {
  anomalies.push(`transition registry unreadable — scene transitions skipped (${e.message})`)
}
if (txRegistry) {
  // scene_id -> worker_id (so we can tell break vs continue boundaries from grouping)
  const sceneWorker = new Map()
  for (const g of groups) for (const sid of g.scene_ids) sceneWorker.set(sid, g.worker_id)

  // Energy classification for the DEFAULT transition (only when the planner did
  // not name one). We scan the entering scene's TONE words — the mood the brief
  // actually describes — NOT layout jargon. Critically we do NOT match words like
  // "hero" / "reveal" / "drop" / "punch": those are composition/layout terms
  // ("centered hero composition", "product reveal") that say nothing about energy,
  // and matching them made every scene default to zoom-through (observed on a real
  // 8-scene promo). Only genuine high-energy TONE words promote to zoom-through;
  // everything else gets the calm universal default (blur-crossfade), which suits
  // most moods and keeps the whole video to ~2 transition types (the "repeat 2-3"
  // principle) instead of a monotonous zoom on every cut.
  const HIGH_TONE_RX =
    /\b(explosive|high[- ]energy|frenetic|kinetic|momentum|powerful|adrenaline|hype|punchy|aggressive|fast[- ]cut|rapid)\b/i

  const briefFor = (sid) => {
    for (const g of groups) if (g.scenes[sid]) return g.scenes[sid].creative_brief || ''
    return ''
  }

  for (let i = 1; i < scenes.length; i++) {
    const fromScene = scenes[i - 1]
    const toScene = scenes[i]
    const fromSid = fromScene.sceneId
    const toSid = toScene.sceneId
    const fromVisual = scene_to_visual[fromSid]
    const toVisual = scene_to_visual[toSid]
    const is_break = sceneWorker.get(fromSid) !== sceneWorker.get(toSid)
    if (fromVisual === toVisual) continue

    // The ENTERING transition is named on the destination scene.
    const named = toScene.transition // { type, direction, duration_s, bridge_id } | null
    let type = named?.type || null
    let direction = named?.direction || null
    const durationOverride = named?.duration_s ?? null

    // Default-fill (no named transition): one calm universal — blur-crossfade,
    // which masks any background shift and reads intentional — unless the entering
    // beat's TONE reads HIGH energy, which promotes to zoom-through. (The old
    // surface-conflict and calm branches both resolved to blur-crossfade too, so
    // they were redundant; zoom-through itself blurs, so it still masks a bg clash.)
    if (!type) {
      // Scan only the FIRST ~160 chars (the beat's mood parenthetical) — the rest is
      // layout prose full of false-positive words.
      const tone = briefFor(toSid).slice(0, 160)
      type = HIGH_TONE_RX.test(tone)
        ? txRegistry.default_high_energy || 'zoom-through'
        : txRegistry.default_calm || 'blur-crossfade'
    }

    const rec = txByName.get(type)
    // All harness transitions are Tier-B visual-clip boundaries. Continue seams
    // inside a group_wN.html are authored by that worker's shared timeline.

    // Resolve direction default for directional types.
    if (rec && Array.isArray(rec.directions) && rec.directions.length > 0 && !direction) {
      direction = rec.default_direction || rec.directions[0]
    }

    const duration_s = Number(
      (durationOverride != null ? durationOverride : (rec?.default_duration_s ?? 0.5)).toFixed(3)
    )

    transitions.push({
      from: fromVisual,
      to: toVisual,
      from_scene: fromSid,
      to_scene: toSid,
      type,
      direction: direction || null,
      duration_s,
      tier: 'b',
      is_break,
      bridge_id: null,
      from_worker: sceneWorker.get(fromSid),
      to_worker: sceneWorker.get(toSid)
    })
  }
}

// ---------- Step 6.5: SFX library copy + cue → global timing ----------
// See lib/prep-sfx.mjs. Runs after Step 6.7 (matching the original ordering) so
// its "sfx lib copied" log and any cue anomalies land in the same sequence.
const sfx = resolveSfx({ sfxLibDir, hyperframesDir, scenes, groups, anomalies })

// ---------- Step 7: emit group_spec.json ----------
const total_duration_s = scenes.reduce((sum, s) => sum + s.estimatedDuration_s, 0)
// BGM may still be rendering (audio.mjs spawns detached and exits before it
// finishes). Trust audio_meta.bgm_path; Phase 4c wait-bgm.mjs writes the final
// status before assemble-index decides whether to emit the <audio> element.
let bgm_path = ''
if (audioMeta?.bgm_path) {
  bgm_path = audioMeta.bgm_path
  if (!existsSync(join(hyperframesDir, audioMeta.bgm_path))) {
    if (audioMeta.bgm_pending) {
      anomalies.push(
        `bgm "${audioMeta.bgm_path}" still rendering (bgm_pending=true) — Phase 4c wait-bgm will check before emitting <audio>`
      )
    } else {
      anomalies.push(
        `bgm "${audioMeta.bgm_path}" listed in audio_meta but missing — Phase 4c will skip if still absent`
      )
    }
  }
}

// Single deterministic gate for the readability-A keep-out + caption band:
// same condition captions.mjs group uses to emit-vs-skip (≥1 scene has a usable
// on-disk wordsPath). When true: build-captions(-html) emit captions, assemble
// mounts track-12, AND every scene worker receives `Captions: enabled` so it
// keeps foreground content in the upper ~83% and reserves the bottom ~17% band.
// When false: no captions and scene workers use full-canvas layouts.
const captions_enabled = scenes.some((s) => Boolean(s.wordsPath))

const spec = {
  scenes_per_group_max: scenesPerGroupMax,
  total_scenes: scenes.length,
  width: CANVAS_W,
  height: CANVAS_H,
  captions_enabled,
  film_direction,
  total_duration_s: Number(total_duration_s.toFixed(3)),
  bgm_path,
  font_face_css: fontFaceCss,
  brand_tokens_css: brandTokensCss,
  groups,
  visual_clips,
  scene_to_visual,
  internal_seams,
  transitions,
  sfx
}

writeFileSync(outPath, JSON.stringify(spec, null, 2))

// Captions: built deterministically in Phase 4a.5 (captions.mjs group →
// caption_groups.json, then captions.mjs html → compositions/captions.html).
// This script only emits the `captions_enabled` gate above; assemble-index.mjs
// checks compositions/captions.html existence and emits the track-12 clip if present.

// ---------- Step 8: summary ----------
console.log(`✓ wrote ${outPath}`)
console.log(
  `  scenes: ${spec.total_scenes}, groups: ${groups.length}, total: ${spec.total_duration_s}s`
)
console.log(`  canvas: ${CANVAS_W}×${CANVAS_H} (${dimSource})`)
console.log(
  `  captions: ${captions_enabled ? 'enabled (scene keep-out + band reserved)' : 'disabled (full-canvas scenes)'}`
)
console.log(
  `  film direction: ${film_direction ? `${film_direction.split(/\s+/).length} words (forward to worker shared header + finalize dispatch)` : '(none — legacy plan format)'}`
)
console.log(`  bgm: ${bgm_path || '(none)'}`)
console.log(
  `  sfx cues:      ${sfx.length}${sfxLibDir ? '' : ' (--sfx-lib not passed; cues dropped)'}`
)
console.log(
  `  visual clips:  ${visual_clips.map((v) => `${v.id}:${v.scene_ids.join('+')}`).join('  ')}`
)
if (transitions.length) {
  const tb = transitions.filter((t) => t.tier === 'b').length
  const ta = transitions.filter((t) => t.tier === 'a').length
  console.log(`  transitions:   ${transitions.length} (tier-b ${tb}, tier-a ${ta})`)
  for (const t of transitions) {
    const dir = t.direction ? ` ${t.direction}` : ''
    console.log(
      `    ${t.from}→${t.to}: ${t.type}${dir} ${t.duration_s}s [tier ${t.tier}, ${t.from_scene}→${t.to_scene}]`
    )
  }
} else {
  console.log(`  transitions:   0 (single visual clip or registry unavailable)`)
}
console.log(`  assets copied: ${copied} (collisions skipped: ${collisions.length})`)
console.log(`  fonts copied:  ${fontsCopied}`)
console.log(
  `  @font-face block: ${fontFaceCss ? `${fontFaceCss.length}B extracted (Phase 4c will inject into index.html <head>)` : '(none — design.html has no auto-injected block)'}`
)
if (chunksIndex) {
  const libCount = chunksIndex.components?.length || 0
  const uniqueComps = new Set()
  for (const s of scenes) {
    for (const p of s.design_chunks?.components || []) uniqueComps.add(basename(p, '.html'))
  }
  console.log(
    `  design-chunks:    ${libCount} component(s) available, forwarded as a style-reference library to every worker (${[...uniqueComps].join(', ') || 'none'})`
  )
} else {
  console.log(`  design-chunks:    none (workers will fall back to design.html)`)
}
for (const g of groups) {
  const items = g.scene_ids.map((id) => `${id}(${g.scenes[id].estimatedDuration_s}s)`).join(', ')
  console.log(`  ${g.worker_id}: ${g.composition_id} ← ${items}`)
}
if (collisions.length) {
  console.log(`\nasset collisions (first-wins, skipped duplicates):`)
  for (const c of collisions.slice(0, 5))
    console.log(`  ${basename(c.kept)} ← skipped ${c.skipped}`)
  if (collisions.length > 5) console.log(`  …and ${collisions.length - 5} more`)
}
if (anomalies.length) {
  console.log(`\nanomalies (non-fatal):`)
  for (const a of anomalies) console.log(`  - ${a}`)
}
