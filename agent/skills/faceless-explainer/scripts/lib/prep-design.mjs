// prep.mjs concern module — resolve the design-system chunk library (Phase 1b's
// emit-chunks.mjs output) onto each scene, and extract the :root brand-tokens
// block. Split out of prep.mjs (Step 4b). Mutates scenes[].design_chunks in place
// and appends to the shared anomalies array; returns chunksIndex for the summary.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { die } from './prep-log.mjs'

// Phase 1b's emit-chunks.mjs writes design-system/chunks/{tokens.css, easings.js,
// components/<id>.html, index.json}. Downstream Phase 4b workers read only the
// chunks listed in their dispatch — never design.html — cutting per-worker
// must-read load by ~4× (12 KB design.html → 1-3 KB per chunk file).
//
// Resolution policy:
//   - chunks/index.json missing       → degrade gracefully: design_chunks = null
//                                       for every scene, log an anomaly, and let
//                                       the worker fall back to reading design.html.
//   - index.json present              → every scene gets tokens_file + easings_file
//                                       + the FULL component library (worker picks).
export function resolveDesignChunks({ designSystemDir, scenes, anomalies }) {
  const chunksDir = join(designSystemDir, 'chunks')
  const chunksIndexPath = join(chunksDir, 'index.json')
  let chunksIndex = null
  if (existsSync(chunksIndexPath)) {
    try {
      chunksIndex = JSON.parse(readFileSync(chunksIndexPath, 'utf8'))
    } catch (e) {
      anomalies.push(
        `design-system/chunks/index.json present but unreadable (${e.message}) — workers will fall back to design.html`
      )
    }
  } else {
    anomalies.push(
      `design-system/chunks/ missing — Phase 1b's emit-chunks.mjs was not run. Workers will fall back to reading design.html (slower).`
    )
  }

  let availableComponents = null
  if (chunksIndex) {
    availableComponents = new Map(
      (chunksIndex.components || []).map((c) => [c.id, join(designSystemDir, c.file)])
    )
  }

  for (const s of scenes) {
    if (!chunksIndex) {
      s.design_chunks = null
      continue
    }
    const tokensAbs = join(designSystemDir, chunksIndex.tokens_file || 'chunks/tokens.css')
    const easingsAbs = join(designSystemDir, chunksIndex.easings_file || 'chunks/easings.js')
    const voiceAbs = join(designSystemDir, chunksIndex.voice_file || 'chunks/voice.md')
    if (!existsSync(tokensAbs))
      die(`design_chunks: tokens_file "${tokensAbs}" referenced by index.json but missing on disk`)
    if (!existsSync(easingsAbs))
      die(
        `design_chunks: easings_file "${easingsAbs}" referenced by index.json but missing on disk`
      )
    if (!existsSync(voiceAbs))
      die(`design_chunks: voice_file "${voiceAbs}" referenced by index.json but missing on disk`)

    // Optional chunks (null when preset declared no §H / §T). Worker reads
    // these on demand — paths are passed through dispatch verbatim. We only check
    // file existence when index.json references one (consistency guard); the
    // worker then opens it lazily without re-checking.
    const hintsAbs = chunksIndex.hints_file ? join(designSystemDir, chunksIndex.hints_file) : null
    if (hintsAbs && !existsSync(hintsAbs))
      die(`design_chunks: hints_file "${hintsAbs}" referenced by index.json but missing on disk`)
    const typeRolesAbs = chunksIndex.type_roles_file
      ? join(designSystemDir, chunksIndex.type_roles_file)
      : null
    if (typeRolesAbs && !existsSync(typeRolesAbs))
      die(
        `design_chunks: type_roles_file "${typeRolesAbs}" referenced by index.json but missing on disk`
      )

    // Components are a style REFERENCE library, not a plan-time citation. Forward
    // EVERY available component to every worker; the worker picks which to use by
    // visual judgment (see agents/hyperframes-scene.md). Existence is guaranteed by
    // emit-chunks; filter defensively so a stale index entry never ships a missing path.
    const componentPaths = availableComponents
      ? [...availableComponents.values()].filter((abs) => existsSync(abs))
      : []
    s.design_chunks = {
      tokens_file: tokensAbs,
      easings_file: easingsAbs,
      voice_file: voiceAbs,
      hints_file: hintsAbs,
      type_roles_file: typeRolesAbs,
      components: componentPaths
    }
  }

  return { chunksIndex }
}

// Extract the :root token block from tokens.css. tokens.css is a single global
// :root {…} block (brand colors, font roles, spacing/radius). Emit it into
// group_spec.brand_tokens_css so assemble-index.mjs can declare it ONCE in
// index.html's <head>; CSS custom properties inherit through the light DOM into
// every mounted sub-composition, so scenes reference var(--*) without re-declaring.
export function extractBrandTokensCss(chunksIndex, designSystemDir) {
  let brandTokensCss = ''
  if (chunksIndex) {
    const tokensAbs = join(designSystemDir, chunksIndex.tokens_file || 'chunks/tokens.css')
    if (existsSync(tokensAbs)) {
      const tokensRaw = readFileSync(tokensAbs, 'utf8')
      const m = tokensRaw.match(/:root\s*\{[\s\S]*\}/)
      brandTokensCss = (m ? m[0] : tokensRaw).trim()
    }
  }
  return brandTokensCss
}
