// Shared loader for the transition registry — the single source of truth for
// PLV scene-to-scene transitions. Parses the ```json fenced block in
// skills/hyperframes-animation/transitions/TRANSITION-REGISTRY.md so the
// validator, prep, injector, and verifier all read the SAME vocabulary +
// GSAP templates. No duplicated allow-lists.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// scripts/lib/ -> ../../.. -> skills/  then into hyperframes-animation/transitions
export const DEFAULT_REGISTRY_PATH = resolve(
  here,
  '../../../hyperframes-animation/transitions/TRANSITION-REGISTRY.md'
)

let _cache = null

// Parse the first ```json … ``` fenced block out of the registry markdown.
export function loadTransitionRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  if (_cache && _cache.path === registryPath) return _cache.data
  let md
  try {
    md = readFileSync(registryPath, 'utf8')
  } catch (e) {
    throw new Error(`transition registry not found at ${registryPath}: ${e.message}`)
  }
  const m = md.match(/```json\s*\n([\s\S]*?)\n```/)
  if (!m) throw new Error(`transition registry ${registryPath} has no \`\`\`json block`)
  let data
  try {
    data = JSON.parse(m[1])
  } catch (e) {
    throw new Error(`transition registry json parse failed: ${e.message}`)
  }
  if (!Array.isArray(data.transitions) || data.transitions.length === 0) {
    throw new Error(`transition registry json has no transitions[]`)
  }
  _cache = { path: registryPath, data }
  return data
}

// Convenience: a Map name -> transition record.
export function transitionsByName(registryPath = DEFAULT_REGISTRY_PATH) {
  const data = loadTransitionRegistry(registryPath)
  const map = new Map()
  for (const t of data.transitions) map.set(t.name, t)
  return map
}

// The set of Tier-A type names (morph / shared-element) — not injectable in
// Phase 1; a `break` boundary must never name one of these.
export function tierATypes(registryPath = DEFAULT_REGISTRY_PATH) {
  const data = loadTransitionRegistry(registryPath)
  return new Set(data.tier_a_types || [])
}
