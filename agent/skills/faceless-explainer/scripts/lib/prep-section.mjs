// prep.mjs concern module — parse section_plan.md (Phase 3) into the film-level
// header + per-scene base records. Pure string→data; no disk access, no timing
// merge (prep.mjs adds rule_paths / design_chunks / the duration ladder after).
// Split out of prep.mjs (Step 3) — the densest single block in the file.
//
// section_plan.md anchors recognised:
//   **Effects:**     — required, 2-5 backtick-wrapped rule ids
//   **Duration:**    — required, positive float seconds
//   **Continuity:**  — required, "break" | "continue" (scene 1 must be break);
//                      drives WORKER GROUPING (a continue run of up to N scenes
//                      shares one worker).
//   **Blueprint:**   — optional (legacy), ignored (loosely parsed into raw only).
//   **Transition:**  — optional, how THIS scene is entered (Tier-B at a break).
//   **Bridge:**      — optional (legacy), ignored.
//   **Hierarchy:**   — optional, validator-only signal (validate-section.mjs reads
//                      it for the risk gate); recognised here so it advances
//                      lastAnchorEnd and never leaks into the worker's brief.
//   **SFX:**         — optional (soft), bullet list of cue lines (scene-local t).
// PrimarySubjectTimeline / Handoff are NOT recognised anchors here, so (per the
// guide) they must appear after SFX to fall into creative_brief.
import { die } from './prep-log.mjs'

const ANCHORS = ['Effects', 'Duration', 'Continuity']
// Components/Surface anchors removed — the design system is a style REFERENCE,
// not a plan-time contract (workers self-pick components from the forwarded
// library; no scene-level surface commitment). Blueprint + Bridge are kept only as
// legacy optional anchors so old plans do not leak them into creative_brief; both ignored.
// `Hierarchy` is a validator-only signal (validate-section.mjs reads it for the
// risk gate); recognise it here so it advances lastAnchorEnd and never leaks into
// the worker's creative_brief.
const OPTIONAL_ANCHORS = ['Blueprint', 'Transition', 'Bridge', 'Hierarchy']

function anchorRe(name) {
  return new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.*)$`, 'm')
}

function parseSceneBlock(body, sceneId, isFirst) {
  const raw = {}
  let lastAnchorEnd = 0
  for (const a of ANCHORS) {
    const m = body.match(anchorRe(a))
    if (!m) die(`${sceneId}: missing **${a}:** anchor in section_plan.md`)
    raw[a] = m[1].trim()
    const end = m.index + m[0].length
    if (end > lastAnchorEnd) lastAnchorEnd = end
  }
  // Optional anchors — include them in lastAnchorEnd when present to avoid leaking
  // into creative_brief; missing optional anchors are fine.
  for (const a of OPTIONAL_ANCHORS) {
    const m = body.match(anchorRe(a))
    if (m) {
      raw[a] = m[1].trim()
      const end = m.index + m[0].length
      if (end > lastAnchorEnd) lastAnchorEnd = end
    }
  }

  // Effects: ordered backtick-wrapped ids inside [...]
  const effects = [...raw.Effects.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  if (effects.length === 0) die(`${sceneId}: **Effects:** has no backtick-wrapped ids`)

  // Duration: leading float
  const durM = raw.Duration.match(/[\d.]+/)
  if (!durM) die(`${sceneId}: **Duration:** could not parse float from "${raw.Duration}"`)
  const estimatedDuration_s = parseFloat(durM[0])
  if (!isFinite(estimatedDuration_s) || estimatedDuration_s <= 0)
    die(`${sceneId}: **Duration:** ${estimatedDuration_s} is not a positive float`)

  // Continuity: break | continue (scene 1 must be break)
  const cont = raw.Continuity.toLowerCase()
  if (cont !== 'break' && cont !== 'continue')
    die(`${sceneId}: **Continuity:** must be "break" or "continue" (got "${raw.Continuity}")`)
  if (isFirst && cont !== 'break') die(`${sceneId}: scene 1 must be **Continuity:** break`)

  // Transition (OPTIONAL): how THIS scene is entered.
  //   **Transition:** <type> [DIRECTION] [<dur>s]
  // Parsed loosely here (validator already shape-checked); null when absent so
  // Step 6.5 can default-fill. Scene 1's transition is the open (no between-
  // scene transition precedes it) — parsed but ignored at injection time.
  let transition = null
  if (raw.Transition) {
    const tokens = raw.Transition.trim().split(/\s+/)
    const type = tokens[0].toLowerCase()
    let direction = null
    let durationOverride = null
    for (const tok of tokens.slice(1)) {
      if (/^[\d.]+s$/i.test(tok)) durationOverride = parseFloat(tok)
      else direction = tok.toUpperCase()
    }
    // Legacy Bridge anchor is intentionally ignored. Continue runs now use one
    // shared-DOM group composition; break seams use only Tier-B wrapper transitions.
    if (type) transition = { type, direction, duration_s: durationOverride, bridge_id: null }
  }

  // SFX (optional / soft anchor; omitted entirely = no SFX for this scene):
  //   **SFX:**
  //   - `impact-bass-1.mp3` at 0.2s, volume 0.35 — hero snap
  //   - `whoosh-short.mp3` at 4.1s — exit
  // (or `**SFX:** none`, or no anchor at all). The validator
  // (validate-section.mjs) no longer requires the anchor; when present it
  // checks each cited file against the manifest. This parser accepts either
  // form. "none" / any non-empty trailer skips the bullet scan (no cues).
  // sfx_cues[].t is SCENE-LOCAL seconds (this function knows nothing about
  // global timing; we add s.start_s offset in Step 6).
  const sfxCues = []
  const sfxHeaderRe = /^\*\*SFX:\*\*[ \t]*(.*)$/m
  const sfxHeaderM = body.match(sfxHeaderRe)
  if (sfxHeaderM) {
    const sfxHeaderEnd = sfxHeaderM.index + sfxHeaderM[0].length
    if (sfxHeaderEnd > lastAnchorEnd) lastAnchorEnd = sfxHeaderEnd
  }
  if (sfxHeaderM && sfxHeaderM[1].trim() === '') {
    const sfxHeaderEnd = sfxHeaderM.index + sfxHeaderM[0].length
    const afterHeader = body.slice(sfxHeaderEnd)
    const lines = afterHeader.split('\n')
    let consumed = 0 // chars consumed past the header
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      const trimmed = line.trim()
      if (trimmed === '') {
        consumed += line.length + 1
        continue
      }
      if (!trimmed.startsWith('-')) break // next anchor / prose / scene heading
      // Parse: `<file>.mp3` at <T>s[, volume <V>][, — <note>]
      const cueRe =
        /^[\s\-*]+`([^`]+\.mp3)`\s+at\s+([\d.]+)\s*s(?:[,\s]+volume\s+([\d.]+))?(?:\s*[—–-]\s*(.*))?$/
      const m = trimmed.match(cueRe)
      if (m) {
        const file = m[1]
        const tLocal = parseFloat(m[2])
        const volume = m[3] != null ? parseFloat(m[3]) : null
        const note = m[4] ? m[4].trim() : ''
        if (!isFinite(tLocal) || tLocal < 0) {
          die(`${sceneId}: **SFX:** invalid t for "${file}": "${m[2]}"`)
        }
        sfxCues.push({ file, t_local: tLocal, volume, note })
      } else {
        die(`${sceneId}: **SFX:** unparseable cue line: "${trimmed}"`)
      }
      consumed += line.length + 1
    }
    const sfxBlockEnd = sfxHeaderEnd + consumed
    if (sfxBlockEnd > lastAnchorEnd) lastAnchorEnd = sfxBlockEnd
  }

  // creative_brief = everything after the LAST anchor line, verbatim
  const brief = body.slice(lastAnchorEnd).replace(/^\s*\n+/, '')

  return {
    effects,
    estimatedDuration_s,
    continuity: cont,
    transition,
    sfxCues,
    creative_brief: brief
  }
}

// Parse the whole plan: the "## Film Direction" header (film-level invariants the
// orchestrator forwards to every worker) + each "## Scene N:" block. Dies on a
// missing required anchor / unparseable value; tolerant when Film Direction is
// absent (legacy plans). Returns base scene records — prep.mjs layers rule_paths,
// design_chunks and the audio-truth duration ladder on top.
export function parseSectionPlan(planText) {
  const sceneHeadRe = /^## Scene\s+(\d+)\s*:\s*(.+?)\s*$/gm
  const heads = [...planText.matchAll(sceneHeadRe)]
  if (heads.length === 0) die("no '## Scene N: <name>' headings found in section_plan.md")

  // Film Direction: the film-level header (`## Film Direction` ... up to the first
  // `## Scene`). Written once by visual-design; the orchestrator prepends it to
  // every scene worker's shared packet header and to the finalize dispatch, so
  // per-scene creative_brief can stay deltas-only. validate-section.mjs enforces
  // presence and size; prep just extracts what is there (tolerant when absent).
  let film_direction = ''
  {
    const fdHead = planText.match(/^## Film Direction[ \t]*$/m)
    if (fdHead && fdHead.index < heads[0].index) {
      film_direction = planText.slice(fdHead.index + fdHead[0].length, heads[0].index).trim()
    }
  }

  const scenes = []
  for (let i = 0; i < heads.length; i++) {
    const m = heads[i]
    const sceneNumber = parseInt(m[1], 10)
    const sceneName = m[2].trim()
    const start = m.index + m[0].length
    const end = i + 1 < heads.length ? heads[i + 1].index : planText.length
    const body = planText.slice(start, end)
    const sceneId = `scene_${sceneNumber}`
    const parsed = parseSceneBlock(body, sceneId, i === 0)
    scenes.push({ sceneNumber, sceneId, sceneName, ...parsed })
  }

  return { film_direction, scenes }
}
