#!/usr/bin/env node
// Validate ./narrator_scripts.json against the Phase 2 canonical schema.
// (Split out of the former merged validate.mjs — narrator and section share no
// logic, so they live as independent, independently-invocable scripts.)
//
// Usage:  node validate-narrator.mjs [path]   (default: ./narrator_scripts.json)
// Run after Phase 2 dispatch returns, before Phase 3 begins.
//
// Exit 0 = pass; non-zero = fail (errors on stderr).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
        errors.push(`${ctx}.narrativeIntent must be an object with [${REQUIRED_INTENT.join(', ')}]`)
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
        const cont = typeof tx.continuity === 'string' ? tx.continuity.toLowerCase() : tx.continuity
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

const target = resolve(process.argv[2] || './narrator_scripts.json')
const errs = validate(target)
if (errs.length) {
  console.error(`✗ ${target}: ${errs.length} schema error(s)`)
  for (const e of errs) console.error(`  - ${e}`)
  process.exit(1)
} else {
  console.log(`✓ ${target}: schema OK`)
}
