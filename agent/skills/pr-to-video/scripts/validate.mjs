#!/usr/bin/env node
// Merged validator. Dispatches by subcommand:
//   node validate.mjs narrator [path]
//       (was: validate-narrator-scripts.mjs [path])
//       Validate ./narrator_scripts.json against the Phase 2 canonical schema.
//       Default path: ./narrator_scripts.json
//   node validate.mjs section [section_plan_path] [rules_dir]
//       (was: validate-section-plan.mjs [section_plan_path] [rules_dir])
//       Validate ./section_plan.md references against hyperframes-animation/rules/.
//       Default section_plan_path: ./section_plan.md
//       Default rules_dir: ../../hyperframes-animation/rules (self-located)
//
// Positional-arg mapping (dispatcher passes argv = process.argv.slice(3)):
//   narrator: original process.argv[2] (path)              -> argv[0]
//   section:  original process.argv[2] (section_plan_path) -> argv[0]
//             original process.argv[3] (rules_dir)         -> argv[1]
//
// Exit 0 = pass; non-zero = fail (errors on stderr).
// Pipeline contract:
//   narrator — run after Phase 2 dispatch returns, before Phase 3 begins.
//   section  — run after Phase 3 dispatch returns, before Phase 4 begins.

import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transitionsByName } from './lib/transition-registry.mjs'

async function runNarrator(argv) {
  const REQUIRED_TOP = ['project', 'narrativeArchetype', 'emotionalArc', 'scenes']
  const REQUIRED_SCENE = [
    'sceneNumber',
    'sceneName',
    'narrativeIntent',
    'transition',
    'assetCandidates',
    'script',
    'estimatedDuration'
  ]
  const REQUIRED_INTENT = ['type', 'narrativeRole', 'keyMessage', 'persuasion', 'emotionalBeat']
  // transition.intent — a soft hint for downstream phases (decoupled model: it no
  // longer drives continuity). `morph` hints that a continue-group's worker should
  // morph a shared element across the seam; cut/slide/dissolve/zoom hint the Tier-B
  // between-scene transition at a `break`. Only enum membership is enforced.
  const VALID_TX_INTENTS = new Set(['morph', 'cut', 'slide', 'dissolve', 'zoom'])
  const VALID_INTENT_TYPES = new Set([
    'hook',
    'pain_point',
    'product_intro',
    'feature_showcase',
    'benefit_highlight',
    'social_proof',
    'branding',
    'cta'
  ])
  // Common drift modes the story-design SKILL.md explicitly warns about.
  const FORBIDDEN_LEGACY = {
    scene_id: 'sceneNumber',
    scene_name: 'sceneName',
    narration: 'script',
    voicePath: '(out of scope; remove)',
    voiceDuration: '(out of scope; remove)'
  }

  // Per-scene script budget — empirically measured against ElevenLabs Rachel (Phase 3 default)
  // for technical narration: 2.2 words/second (= ~130 wpm). Story-design agents historically
  // overestimate speech rate (writing ~5 wps estimates that translate to 2-2.5× longer
  // actual TTS), which inflates scene durations and pushes the multi-phase choreography's
  // idle tail past the user-readable budget. We enforce a realistic floor here so visual-design
  // and prep plan against truth, not against the agent's guess.
  const TTS_WPS = 2.2
  const SCENE_TARGET_S = 9 // soft target — visible warning above this
  const SCENE_HARDCAP_S = 12 // hard cap — fatal error above this (= ~26 words)
  const SCENE_EXCEPTION_BUDGET = 2 // allow this many scenes to exceed soft target (the main feature_showcase, etc.)

  function scriptWordCount(script) {
    if (typeof script !== 'string') return 0
    const stripped = script.replace(/<[^>]+>/g, ' ').trim()
    if (!stripped) return 0
    return stripped.split(/\s+/).length
  }

  function parseSecondsToken(token) {
    // Accepts: 6 | "6" | "6s" | "5-6s" | "5 - 6 s" — picks upper bound.
    if (typeof token === 'number' && Number.isFinite(token)) return token
    if (typeof token !== 'string') return NaN
    const range = token.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*s?\s*$/)
    if (range) return parseFloat(range[2])
    const single = token.match(/(\d+(?:\.\d+)?)\s*s?\s*$/)
    return single ? parseFloat(single[1]) : NaN
  }

  function validate(filePath) {
    const errors = []
    let raw
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch {
      return [`File not found: ${filePath}`]
    }
    let data
    try {
      data = JSON.parse(raw)
    } catch (e) {
      return [`Invalid JSON: ${e.message}`]
    }

    for (const key of REQUIRED_TOP) {
      if (!(key in data)) errors.push(`Missing top-level field "${key}"`)
    }

    for (const [legacy, correct] of Object.entries(FORBIDDEN_LEGACY)) {
      if (legacy in data) {
        errors.push(`Top-level forbidden field "${legacy}" — use "${correct}" instead`)
      }
    }

    if (Array.isArray(data.scenes)) {
      data.scenes.forEach((scene, i) => {
        const ctx = `scenes[${i}]`

        for (const key of REQUIRED_SCENE) {
          if (!(key in scene)) errors.push(`${ctx}: missing "${key}"`)
        }

        for (const [legacy, correct] of Object.entries(FORBIDDEN_LEGACY)) {
          if (legacy in scene) {
            errors.push(`${ctx}: forbidden "${legacy}" — use "${correct}"`)
          }
        }

        if (scene.narrativeIntent && typeof scene.narrativeIntent === 'object') {
          for (const key of REQUIRED_INTENT) {
            if (!(key in scene.narrativeIntent)) {
              errors.push(`${ctx}.narrativeIntent: missing "${key}"`)
            }
          }
          const t = scene.narrativeIntent.type
          if (t && !VALID_INTENT_TYPES.has(t)) {
            errors.push(
              `${ctx}.narrativeIntent.type: "${t}" not in allowed set [${[...VALID_INTENT_TYPES].join(', ')}]`
            )
          }
        } else if ('narrativeIntent' in scene) {
          errors.push(
            `${ctx}.narrativeIntent must be an object with [${REQUIRED_INTENT.join(', ')}]`
          )
        }

        // Flattened-intent-fields trap (intent fields living on scene root instead of nested).
        for (const intentKey of REQUIRED_INTENT) {
          if (
            intentKey in scene &&
            (!scene.narrativeIntent || !(intentKey in scene.narrativeIntent))
          ) {
            errors.push(
              `${ctx}: "${intentKey}" flat on the scene — must live inside "narrativeIntent"`
            )
          }
        }

        // assetCandidates shape — must be an array of {path, description}.
        // Empty array is allowed (text-only scenes).
        if ('assetCandidates' in scene) {
          if (!Array.isArray(scene.assetCandidates)) {
            errors.push(`${ctx}.assetCandidates must be an array (use [] for text-only scenes)`)
          } else {
            scene.assetCandidates.forEach((cand, j) => {
              const cctx = `${ctx}.assetCandidates[${j}]`
              if (!cand || typeof cand !== 'object') {
                errors.push(`${cctx}: must be an object with {path, description}`)
                return
              }
              if (typeof cand.path !== 'string' || !cand.path) {
                errors.push(`${cctx}: missing or empty "path"`)
              } else if (!cand.path.startsWith('public/')) {
                errors.push(`${cctx}.path: must start with "public/" (got "${cand.path}")`)
              }
              if (typeof cand.description !== 'string' || !cand.description) {
                errors.push(`${cctx}: missing or empty "description"`)
              }
            })
          }
        }

        // transition (decoupled model): `continuity` drives WORKER GROUPING only —
        // "continue" = authored by the same worker as the previous scene (a continuous
        // run of up to 3 scenes; one worker owns all their DOMs and authors the visual
        // continuity / optional shared-element morph itself). "break" = a new worker +
        // a Tier-B transition between. `intent` and `sharedMotif` are soft hints for the
        // visual-design / scene phases — NOT a rigid biconditional. (Tier-A shared-element
        // bridges were removed when continue and morph were decoupled.)
        const tx = scene.transition
        if (tx && typeof tx === 'object') {
          const intent = tx.intent
          const cont =
            typeof tx.continuity === 'string' ? tx.continuity.toLowerCase() : tx.continuity
          if (intent != null && !VALID_TX_INTENTS.has(intent)) {
            errors.push(
              `${ctx}.transition.intent: "${intent}" not in [${[...VALID_TX_INTENTS].join(', ')}]`
            )
          }
          if (cont != null && cont !== 'break' && cont !== 'continue') {
            errors.push(
              `${ctx}.transition.continuity: must be "break" or "continue" (got "${tx.continuity}")`
            )
          }
          if (i === 0 && cont != null && cont !== 'break') {
            errors.push(`${ctx}.transition.continuity: scene 1 must be "break"`)
          }
        } else if ('transition' in scene) {
          errors.push(`${ctx}.transition must be an object {continuity, intent, ...}`)
        }

        // captions field is no longer consumed (LV2 captions are agent-authored
        // in Phase 4a.5 from whisper word JSON). Surface a stderr warning if it's
        // still present so story-design templates get updated, but don't fail
        // validation — old narrator_scripts.json files should still pass.
        if ('captions' in scene) {
          console.warn(
            `! ${ctx}.captions: field is deprecated and ignored by Phase 4a.5 captions agent — remove from narrator_scripts.json`
          )
        }

        // Per-scene script-length budget — see TTS_WPS / SCENE_TARGET_S above.
        const wc = scriptWordCount(scene.script)
        const predictedS = wc / TTS_WPS
        if (predictedS > SCENE_HARDCAP_S) {
          errors.push(
            `${ctx}.script: ${wc} words predicts ${predictedS.toFixed(1)}s at the realistic ${TTS_WPS} wps TTS rate — exceeds the ${SCENE_HARDCAP_S}s/scene hard cap (≤ ${Math.floor(SCENE_HARDCAP_S * TTS_WPS)} words). Trim clauses; this scene's idle phase will dominate the visual.`
          )
        }
        const statedS = parseSecondsToken(scene.estimatedDuration)
        if (Number.isFinite(statedS) && statedS > 0 && statedS < predictedS * 0.7) {
          console.warn(
            `! ${ctx}.estimatedDuration: "${scene.estimatedDuration}" understates a ${wc}-word script — realistic TTS at ${TTS_WPS} wps ≈ ${predictedS.toFixed(1)}s. Update so downstream (audio_meta, visual-design phases) plans against truth, not a fast-talking guess.`
          )
        }
        // Annotate for the per-film summary outside the loop.
        scene.__predictedS = predictedS
        scene.__wc = wc
      })

      // Per-film scene-budget summary — flag if too many scenes exceed the soft target.
      // (Hard cap was already errored above; this catches "every scene is 10-11s" drift.)
      const overSoft = data.scenes.filter((s) => s.__predictedS > SCENE_TARGET_S)
      if (overSoft.length > SCENE_EXCEPTION_BUDGET) {
        console.warn(
          `! script budget: ${overSoft.length} of ${data.scenes.length} scene(s) exceed the ${SCENE_TARGET_S}s soft target (≤ ${Math.floor(SCENE_TARGET_S * TTS_WPS)} words) — only ${SCENE_EXCEPTION_BUDGET} allowed (typically the main feature_showcase / a complex causal-chain scene). Trim the rest:\n` +
            overSoft
              .map(
                (s) =>
                  `    - scene ${s.sceneNumber} (${s.sceneName}): ${s.__wc} words → ~${s.__predictedS.toFixed(1)}s`
              )
              .join('\n')
        )
      }
      // Clean up scratch fields so the schema check below stays clean for downstream re-reads.
      data.scenes.forEach((s) => {
        delete s.__predictedS
        delete s.__wc
      })

      // UI demo requirement from story-design SKILL.md.
      const types = data.scenes.flatMap((s) =>
        s.narrativeIntent?.type ? [s.narrativeIntent.type] : []
      )
      if (!types.some((t) => t === 'feature_showcase' || t === 'product_intro')) {
        errors.push(
          'No scene with type=feature_showcase or product_intro — story-design requires at least one UI-demo scene'
        )
      }
    } else if ('scenes' in data) {
      errors.push('scenes must be an array')
    }

    return errors
  }

  const target = resolve(argv[0] || './narrator_scripts.json')
  const errs = validate(target)
  if (errs.length) {
    console.error(`✗ ${target}: ${errs.length} schema error(s)`)
    for (const e of errs) console.error(`  - ${e}`)
    process.exit(1)
  } else {
    console.log(`✓ ${target}: schema OK`)
  }
}

async function runSection(argv) {
  function loadKnownEffects(rulesDir) {
    return new Set(
      readdirSync(rulesDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => basename(f, '.md'))
    )
  }

  const planPath = resolve(argv[0] || './section_plan.md')

  const here = dirname(fileURLToPath(import.meta.url))
  const defaultRulesDir = resolve(here, '../../hyperframes-animation/rules')
  const rulesDir = resolve(argv[1] || defaultRulesDir)

  let plan
  try {
    plan = readFileSync(planPath, 'utf8')
  } catch {
    console.error(`✗ section_plan.md not found at ${planPath}`)
    process.exit(1)
  }

  let known
  try {
    known = loadKnownEffects(rulesDir)
  } catch (e) {
    console.error(`✗ rules dir not readable at ${rulesDir}: ${e.message}`)
    process.exit(1)
  }

  // SFX manifest (self-located relative to this script, like the default rules dir
  // above). Used to validate that each cited `<file>.mp3` actually exists in the
  // library — turning what used to be a silent Phase-4a drop (prep.mjs only pushed
  // an anomaly) into a loud, in-loop Phase-3 error. SFX itself stays optional: a
  // scene with no anchor is fine; only a *cited* file that doesn't exist fails.
  // Best-effort: an unreadable manifest downgrades to syntax-only validation
  // (prep.mjs still drops unknown files as a backstop).
  let sfxKnownFiles = null
  try {
    const sfxManifestPath = resolve(here, '../assets/sfx/manifest.json')
    const sfxManifest = JSON.parse(readFileSync(sfxManifestPath, 'utf8'))
    sfxKnownFiles = new Set(
      Object.values(sfxManifest)
        .map((e) => e?.file)
        .filter(Boolean)
    )
  } catch {
    // manifest absent/unreadable — skip membership check.
  }

  const errors = []
  let totalEffectsCited = 0
  let totalSfxCited = 0

  // ---- Per-scene anchor validation (Phase 4a contract) ----
  // Every "## Scene N:" block must have all three required anchors. Phase 4a's
  // prep.mjs reads these deterministically; missing anchors break the build.
  const sceneHeadRe = /^## Scene\s+(\d+)\s*:\s*(.+?)\s*$/gm
  const heads = [...plan.matchAll(sceneHeadRe)]
  const ANCHORS = ['Effects', 'Duration', 'Continuity']
  // Components/Surface anchors removed — the design system is a style REFERENCE,
  // not a plan-time contract. Workers pick components by visual judgment from the
  // forwarded library; surface is no longer a scene-level commitment. The optional
  // anchors (Transition/Bridge/SFX) are validated inline below when
  // present, not enforced as a required set — so there's no OPTIONAL_ANCHORS list.

  // Transition vocabulary — loaded from the single source of truth so this
  // validator never drifts from prep/injector. Absence of the anchor is fine
  // (prep default-fills); when present, type/direction/duration are checked here.
  let TX_BY_NAME = new Map()
  try {
    TX_BY_NAME = transitionsByName()
  } catch (e) {
    // Non-fatal: if the registry can't be read, skip Transition validation rather
    // than block the whole plan check. prep.mjs will surface a hard error later.
    console.error(
      `⚠ transition registry unreadable, skipping **Transition:** validation — ${e.message}`
    )
  }

  const hasAnchor = (body, name) => {
    const re = new RegExp(`^\\*\\*${name}:\\*\\*`, 'mi')
    return re.test(body)
  }

  const hasAny = (text, patterns) => patterns.some((pattern) => pattern.test(text))

  const hierarchyActionRe =
    /\b(exit|hide|hidden|compact|demote|supporting|rail|background|outside|safe zone|safe-zone)\b/i
  const supportingRe =
    /\b(supporting|demote|rail|side rail|bottom rail|background texture|low-contrast|lower contrast|smaller|outside)\b/i

  // Strip negated clauses so a scene that only mentions proof to DENY it (e.g. a
  // pure CTA: "there is no logo strip / customer logo / stat counter / chart")
  // doesn't read as a proof scene. Each negation eats to the next sentence stop.
  // This is what lets a CTA stop writing anti-regex defensive prose.
  function stripNegations(text) {
    return text.replace(
      /\b(no|not|never|without|isn'?t|aren'?t|don'?t|doesn'?t|won'?t|cannot|can'?t)\b[^.;:]*/gi,
      ' '
    )
  }

  function hierarchyRisk(body) {
    const text = body.toLowerCase()
    // Proof signals are read from (1) cited component ids — an unambiguous,
    // structured signal preferred over fuzzy prose scans — and (2) the prose with
    // negated clauses removed, using PHRASE patterns (not bare "logo"/"customer",
    // which over-trigger on brand wordmarks and incidental mentions).
    const proofText = stripNegations(text)
    const compM = body.match(/^\*\*Components:\*\*\s*(.*)$/m)
    const compIds = compM ? [...compM[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : []
    const compProof = compIds.some((id) => /logo|proof|testimonial|customer/i.test(id))
    const compData = compIds.some((id) => /stat|chart|metric|kpi|counter/i.test(id))

    const multiAct = /\b(multi[- ]?act|three[- ]?act|act\s+[abc]|\bfocal points?)\b/i.test(text)
    const hasAction =
      /\b(cta|get started|call[- ]?to[- ]?action|button|sign up|book demo|start trial|download|subscribe|contact sales|action headline|payoff frame|payoff close|closing action)\b/i.test(
        text
      )
    const hasSocialProof =
      compProof ||
      hasAny(proofText, [
        /logo[- ]?(strip|grid|wall|cloud|chain|row|rail|lockup)/i,
        /\btrusted by\b/i,
        /social[- ]proof/i,
        /\btestimonials?\b/i,
        /customer logos?/i,
        /enterprise logos?/i,
        /\bbrands? you (know|trust)\b/i
      ])
    const hasDataProof =
      compData ||
      hasAny(proofText, [
        /\bstats?\b/i,
        /\bstat[- ]?counter\b/i,
        /\bmetrics?\b/i,
        /\bkpis?\b/i,
        /\bproof cluster\b/i,
        /\bproof rail\b/i,
        /\bchart\b/i,
        /\bcount[- ]?up\b/i,
        /\bpolicy compliance\b/i,
        /\bhours saved\b/i,
        /\byield\b/i
      ])
    return {
      multiAct,
      hasAction,
      hasSocialProof,
      hasDataProof,
      risky: multiAct || (hasAction && (hasSocialProof || hasDataProof))
    }
  }

  if (heads.length === 0) {
    errors.push(
      "No '## Scene N: <name>' headings found — section_plan must have at least one scene block."
    )
  }

  // File shape: optional H1 title + ONE "## Film Direction" block + the
  // "## Scene N:" blocks, nothing else. Film Direction is the film-level header
  // (write-once invariants: palette system, motion defaults + budget, ambient
  // system, negative list, transition vocabulary, asset coverage table — see
  // guide.md §4). Unlike the old free preamble it IS read downstream: prep.mjs
  // copies it into group_spec.film_direction, and the orchestrator prepends it
  // to every scene worker's shared packet header and the finalize dispatch.
  // Scene prose carries only scene-specific deltas on top of it.
  if (heads.length > 0) {
    const fdMatch = plan.slice(0, heads[0].index).match(/^## Film Direction[ \t]*$/m)
    if (!fdMatch) {
      errors.push(
        'missing "## Film Direction" block before "## Scene 1" — write the film-level invariants (palette system, motion defaults + budget, ambient system, film negative list, transition vocabulary, asset coverage table) ONCE in this header; scene prose then carries only scene-specific deltas. See guide.md §4.'
      )
    } else {
      const fdBody = plan.slice(fdMatch.index + fdMatch[0].length, heads[0].index)
      const fdWords = fdBody.split(/\s+/).filter(Boolean).length
      if (fdWords > 700) {
        errors.push(
          `"## Film Direction" is ${fdWords} words — keep it a one-page header (≤700 words). If it is growing, per-scene choreography is leaking up; that detail belongs in the scene blocks.`
        )
      }
      const preamble = plan
        .slice(0, fdMatch.index)
        .replace(/^﻿?[ \t]*#[ \t]+.*$/m, '') // allow one leading H1 title line
        .replace(/\s+/g, ' ')
        .trim()
      if (preamble.length > 200) {
        errors.push(
          `project-level preamble detected before "## Film Direction" (${preamble.length} chars beyond an H1 title) — section_plan.md must contain only an H1 title, one "## Film Direction" block, and "## Scene N:" blocks.`
        )
      }
    }
  }

  for (let i = 0; i < heads.length; i++) {
    const m = heads[i]
    const sceneNumber = m[1]
    const sceneId = `scene_${sceneNumber}`
    const start = m.index + m[0].length
    const end = i + 1 < heads.length ? heads[i + 1].index : plan.length
    const body = plan.slice(start, end)

    // Block order: all **Anchor:** lines (incl. SFX bullets, PrimarySubjectTimeline,
    // Handoff) must precede the free prose. Once a prose sentence appears, no anchor
    // line may follow — interleaving makes prep.mjs's "creative_brief = text after
    // the last recognized anchor" slice unpredictable (e.g. PST/Handoff dropping out
    // of, or prose leaking into, the worker's brief). See guide.md section 2, "block order".
    // PST/Handoff continuation lines (timecode-led) and bullets are NOT prose.
    {
      const ANCHOR_LINE_RE =
        /^\*\*(Effects|Duration|Continuity|Blueprint|Transition|Bridge|SFX|PrimarySubjectTimeline|Handoff):\*\*/
      const blockLines = body.split('\n')
      let firstProse = -1
      let lastAnchor = -1
      let proseWords = 0
      for (let li = 0; li < blockLines.length; li++) {
        const t = blockLines[li].trim()
        if (t === '') continue
        if (ANCHOR_LINE_RE.test(t)) {
          lastAnchor = li
          continue
        }
        if (/^[-*]/.test(t)) continue // SFX cue bullets
        if (/^[\d>#`]/.test(t)) continue // timecode continuations / quotes / code / fences
        if (firstProse === -1) firstProse = li
        proseWords += t.split(/\s+/).filter(Boolean).length
      }
      if (firstProse !== -1 && lastAnchor > firstProse) {
        errors.push(
          `${sceneId}: an **Anchor:** line appears after the prose began (prose at body line ${firstProse}, anchor at ${lastAnchor}) — put ALL anchors (incl. SFX/PrimarySubjectTimeline/Handoff) before the prose`
        )
      }
      // Lean-prose cap: the brief is deltas on top of "## Film Direction"
      // (target ≤150 words; hard cap leaves room for genuinely complex scenes).
      // Walls of prose here are almost always film-level invariants restated
      // per scene — palette ratios, caption-band geometry, ambient layers,
      // breathing defaults — which the worker already receives via the header.
      if (proseWords > 320) {
        errors.push(
          `${sceneId}: prose is ${proseWords} words (target ≤150, hard cap 320) — keep only scene-specific deltas; film-level invariants (palette system / ambient layers / motion defaults / caption geometry) belong in "## Film Direction", not in every scene. See guide.md §4.`
        )
      }
    }

    const found = {}
    for (const a of ANCHORS) {
      const re = new RegExp(`^\\*\\*${a}:\\*\\*\\s*(.*)$`, 'm')
      const am = body.match(re)
      if (!am) {
        errors.push(`${sceneId}: missing **${a}:** anchor`)
      } else {
        found[a] = am[1].trim()
      }
    }

    if (found.Continuity != null) {
      const v = found.Continuity.toLowerCase()
      if (v !== 'break' && v !== 'continue') {
        errors.push(
          `${sceneId}: **Continuity:** must be "break" or "continue" (got "${found.Continuity}")`
        )
      } else if (i === 0 && v !== 'break') {
        errors.push(`${sceneId}: scene 1 must be **Continuity:** break`)
      }
    }

    // Transition (OPTIONAL): how this scene is ENTERED. Shape:
    //   **Transition:** <type> [DIRECTION] [<dur>s]
    // e.g. `blur-crossfade`, `push-slide LEFT`, `zoom-through 0.3s`.
    // Absent → prep default-fills. Scene 1's is the open (ignored as a between-
    // scene transition) but still shape-checked if present. Only validated when
    // the registry loaded (TX_BY_NAME non-empty).
    // Decoupled model: `continuity` (parsed above) drives WORKER GROUPING only —
    // "continue" = same worker as the previous scene (a continuous run of up to 3; the
    // worker authors the visual continuity / optional shared-element morph itself). There
    // is no Tier-A bridge or **Bridge:** anchor anymore. A **Transition:** anchor, if
    // present, names the Tier-B between-scene transition used at a `break` boundary
    // (ignored on a `continue` seam, where the harness lays a short crossfade itself).
    const txMatch = body.match(/^\*\*Transition:\*\*\s*(.*)$/m)
    if (txMatch && TX_BY_NAME.size > 0) {
      const raw = txMatch[1].trim()
      if (raw === '') {
        errors.push(`${sceneId}: **Transition:** is empty — name a type or omit the anchor`)
      } else {
        const tokens = raw.split(/\s+/)
        const type = tokens[0].toLowerCase()
        const rec = TX_BY_NAME.get(type)
        if (!rec) {
          errors.push(
            `${sceneId}: **Transition:** unknown type "${type}" (known: ${[...TX_BY_NAME.keys()].join(', ')})`
          )
        } else {
          // direction / duration trailing tokens
          for (const tok of tokens.slice(1)) {
            const t = tok.toLowerCase()
            if (/^[\d.]+s$/.test(t)) {
              const dur = parseFloat(t)
              if (!(dur > 0) || dur > 2.0) {
                errors.push(
                  `${sceneId}: **Transition:** duration "${tok}" out of range (0 < dur ≤ 2.0s)`
                )
              }
            } else {
              const dir = tok.toUpperCase()
              const allowed = rec?.directions || []
              if (!allowed.includes(dir)) {
                errors.push(
                  `${sceneId}: **Transition:** "${type}" does not take direction "${tok}"${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (this type is non-directional)'}`
                )
              }
            }
          }
        }
      }
    }

    if (found.Duration != null) {
      const dm = found.Duration.match(/[\d.]+/)
      if (!dm || !(parseFloat(dm[0]) > 0)) {
        errors.push(`${sceneId}: **Duration:** must be a positive float (got "${found.Duration}")`)
      }
    }

    // SFX anchor (OPTIONAL / soft): a scene with no sound effects simply omits the
    // anchor — absence is a valid "no SFX" decision, not an error. When the anchor
    // IS present we validate its shape AND that every cited `<file>.mp3` exists in
    // the SFX manifest. That membership check is what lets the anchor stay optional
    // safely: a typo'd filename surfaces here (Phase 3, fixable in-loop) instead of
    // being silently dropped by prep.mjs at Phase 4a. `**SFX:** none` is still
    // accepted (explicit zero-cue), just no longer required.
    const sfxLineRe = /^\*\*SFX:\*\*[ \t]*(.*)$/m
    const sfxLineM = body.match(sfxLineRe)
    if (sfxLineM) {
      const trailer = sfxLineM[1].trim()
      if (trailer.toLowerCase() === 'none') {
        // explicit zero-cue decision — OK
      } else if (trailer !== '') {
        errors.push(
          `${sceneId}: **SFX:** header line must be empty or "none" — put cue bullets on subsequent lines (got "${trailer}")`
        )
      } else {
        const after = body.slice(sfxLineM.index + sfxLineM[0].length).split('\n')
        const citedFiles = []
        for (const line of after) {
          const t = line.trim()
          if (t === '') continue
          if (!t.startsWith('-')) break // next anchor / prose / scene heading
          const fm = t.match(/`([^`]+\.mp3)`/)
          if (fm) citedFiles.push(fm[1])
        }
        if (citedFiles.length === 0) {
          errors.push(
            `${sceneId}: **SFX:** header present but no \`<file>.mp3\` bullet follows — add cue bullets or remove the anchor`
          )
        } else if (sfxKnownFiles) {
          for (const f of citedFiles) {
            if (!sfxKnownFiles.has(f)) {
              errors.push(
                `${sceneId}: **SFX:** cites "${f}" not in the SFX manifest (known: ${[...sfxKnownFiles].sort().join(', ')})`
              )
            } else {
              totalSfxCited++
            }
          }
        } else {
          totalSfxCited += citedFiles.length
        }
      }
    }

    const risk = hierarchyRisk(body)
    if (risk.risky) {
      const needs = risk.multiAct ? 'multi-act scene' : 'action/payoff + proof scene'
      if (!hasAnchor(body, 'PrimarySubjectTimeline')) {
        errors.push(
          `${sceneId}: ${needs} must include **PrimarySubjectTimeline:** with exactly one primary subject per time range`
        )
      } else if (!/\bprimary\b/i.test(body)) {
        errors.push(`${sceneId}: **PrimarySubjectTimeline:** must name the primary subject(s)`)
      }

      if (!hasAnchor(body, 'Handoff')) {
        errors.push(
          `${sceneId}: ${needs} must include **Handoff:** explaining how previous primary exits, hides, compacts, or demotes`
        )
      } else if (!hierarchyActionRe.test(body)) {
        errors.push(
          `${sceneId}: **Handoff:** must include an explicit action: exit, hide, compact, demote, supporting, rail, or outside safe zone`
        )
      }

      if (
        risk.hasAction &&
        (risk.hasSocialProof || risk.hasDataProof) &&
        !supportingRe.test(body)
      ) {
        errors.push(
          `${sceneId}: action/payoff + proof can coexist only if proof is explicitly supporting/demoted/rail/background/outside the primary bbox`
        )
      }
    }

    if (found.Effects != null) {
      const ids = [...found.Effects.matchAll(/`([^`]+)`/g)].map((m) => m[1])
      if (ids.length === 0) {
        errors.push(`${sceneId}: **Effects:** has no backtick-wrapped ids`)
      } else {
        for (const id of ids) {
          if (!known.has(id)) {
            errors.push(
              `${sceneId}: **Effects:** cites unknown rule "${id}" — not under hyperframes-animation/rules/`
            )
          } else {
            totalEffectsCited++
          }
        }
      }
    }
  }

  // Sanity: if no scenes had any known effect, complain at the top level (per-scene
  // errors will have surfaced the specifics, but make the overall failure obvious).
  if (heads.length > 0 && totalEffectsCited === 0 && errors.length === 0) {
    errors.push(
      "Zero known effects cited across all scenes — every scene's **Effects:** must include at least one rule from hyperframes-animation/rules/."
    )
  }

  if (errors.length) {
    console.error(`✗ ${planPath}: ${errors.length} issue(s)`)
    for (const e of errors) console.error(`  - ${e}`)
    console.error(`\n  Known rules: \`ls ${rulesDir}\``)
    process.exit(1)
  }

  const sfxNote = totalSfxCited > 0 ? `, ${totalSfxCited} SFX cue(s)` : ''
  console.log(
    `✓ ${planPath}: ${heads.length} scene(s), ${totalEffectsCited} effect citation(s)${sfxNote} — OK`
  )
}

const sub = process.argv[2]
const rest = process.argv.slice(3)
switch (sub) {
  case 'narrator':
    await runNarrator(rest)
    break
  case 'section':
    await runSection(rest)
    break
  default:
    console.error('usage: node validate.mjs <narrator|section> [args...]')
    process.exit(2)
}
