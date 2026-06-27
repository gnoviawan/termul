#!/usr/bin/env node
// check-compositions.mjs — Step 7 finalize preflight harness
//
// Runs after all Step 6 workers return and before Step 7 finalize starts assembling index.html.
// Catches historical worker bugs (finalize used to spend 13 minutes on average
// in edit-and-retry debugging):
//
//   1. Wrapper-ancestor selector: CSS / JS selector written as `.<scene-id>-root .foo`
//      / `.<scene-id>-root #foo`. Preview / snapshot works because the bundler keeps
//      the wrapper, but `hyperframes render` uses the producer pipeline, which strips
//      that wrapper, so every selector misses and the scene renders black or as raw DOM.
//      Correct form: plain `.s<N>-foo` / `#s<N>-foo`; the runtime scoper adds host scope.
//   2. Self data-composition-id selector: CSS written as
//      `[data-composition-id="<scene-id>"] { ... }` triggers the newer CLI
//      `composition_self_attribute_selector` warning. Root styles should use `#root`.
//   3. Scene-root id selector: `#<scene-id>-root` is not a runtime contract.
//      Root may only use `#root`; scene-internal elements use `#s<N>-foo`.
//   4. Missing root contract: no `id="root"`, no `class="<scene-id>-root"`, no
//      `data-composition-id`, no `data-duration`, or no `window.__timelines[...]`.
//   5. Asset references a file absent from <project-root>/public/: the worker invented
//      or misspelled the basename.
//
// Usage:
//   node check-compositions.mjs --hyperframes . --group-spec ./group_spec.json
//
// Exit codes:
//   0 = all compositions pass. stdout prints the summary.
//   1 = one or more fatal violations. stderr lists per-scene, per-rule failures; the
//       orchestrator should re-dispatch affected workers instead of patching in finalize.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const hyperframesDir = resolve(flag('hyperframes', '.'))
const groupSpecPath = resolve(flag('group-spec', './group_spec.json'))
const compositionsDir = join(hyperframesDir, 'compositions')

if (!existsSync(groupSpecPath)) {
  console.error(`✗ group_spec.json not found at ${groupSpecPath}`)
  process.exit(1)
}
if (!existsSync(compositionsDir)) {
  console.error(`✗ compositions dir not found at ${compositionsDir}`)
  process.exit(1)
}

const groupSpec = JSON.parse(readFileSync(groupSpecPath, 'utf8'))
const sceneIds = (groupSpec.groups || []).flatMap((g) => g.scene_ids || [])

if (sceneIds.length === 0) {
  console.error(`✗ no scene_ids found in group_spec.json`)
  process.exit(1)
}

// scene_id → group entry (for component-meta lookup)
const sceneEntries = new Map()
for (const g of groupSpec.groups || []) {
  for (const sid of g.scene_ids || []) {
    sceneEntries.set(sid, g.scenes?.[sid] || {})
  }
}

const visualTargets =
  Array.isArray(groupSpec.visual_clips) && groupSpec.visual_clips.length > 0
    ? groupSpec.visual_clips.map((v) => ({
        id: String(v.id || ''),
        file: String(v.file || `compositions/${v.id}.html`),
        kind: v.kind || 'scene',
        sceneIds: Array.isArray(v.scene_ids) ? v.scene_ids : []
      }))
    : sceneIds.map((sid) => ({
        id: sid,
        file: `compositions/${sid}.html`,
        kind: 'scene',
        sceneIds: [sid]
      }))

if (visualTargets.length === 0) {
  console.error(`✗ no visual clips found in group_spec.json`)
  process.exit(1)
}

// Component metadata lookup — chunks/index.json carries rank / forbidden_with /
// trigger_signals / visual_role per component (written by emit-chunks.mjs).
// Keyed by component id, which equals the html file's basename. Empty when the
// preset hasn't migrated to the new schema; rank checks then silently skip.
const componentMeta = new Map()
{
  // Resolve chunks/index.json off the first scene's design_chunks.tokens_file —
  // tokens_file is required by prep.mjs so it's always present when chunks were
  // emitted. Walk up from chunks/tokens.css → chunks/ → chunks/index.json.
  const anyScene = [...sceneEntries.values()].find((e) => e.design_chunks?.tokens_file)
  const tokensPath = anyScene?.design_chunks?.tokens_file
  if (tokensPath) {
    const chunksDir = dirname(tokensPath)
    const indexPath = join(chunksDir, 'index.json')
    if (existsSync(indexPath)) {
      try {
        const index = JSON.parse(readFileSync(indexPath, 'utf8'))
        for (const c of index.components || []) {
          componentMeta.set(c.id, {
            rank: c.rank ?? null,
            trigger_signals: c.trigger_signals || [],
            forbidden_with: c.forbidden_with || [],
            visual_role: c.visual_role || null
          })
        }
      } catch {
        // Malformed index.json — skip metadata-driven checks; let other gates flag the data issue
      }
    }
  }
}

// Given an absolute path like "/.../chunks/components/hero.html", return the
// component id "hero". Returns null if path doesn't fit the expected shape so
// callers can skip safely.
function componentIdFromPath(absPath) {
  if (typeof absPath !== 'string') return null
  const m = absPath.match(/\/chunks\/components\/([a-z0-9-]+)\.html$/)
  return m ? m[1] : null
}

const errors = [] // fatal: { sceneId, rule, detail }
const anomalies = [] // non-fatal: { sceneId, rule, detail }

for (const target of visualTargets) {
  const sceneId = target.id
  const compRel = target.file || `compositions/${sceneId}.html`
  const filePath = join(hyperframesDir, compRel)

  // Rule 0: file exists and is non-empty
  if (!existsSync(filePath) || statSync(filePath).size === 0) {
    errors.push({
      sceneId,
      rule: 'file',
      detail: `${compRel} missing or empty`
    })
    continue // Skip remaining rules for this scene.
  }

  const html = readFileSync(filePath, 'utf8')

  // Rule 1: root div contract
  // There must be exactly one root div with both id="root" and class="<scene-id>-root".
  const rootDivRe = new RegExp(
    `<div\\b[^>]*\\bid=["']root["'][^>]*\\bclass=["'][^"']*\\b${sceneId}-root\\b[^"']*["']`,
    'i'
  )
  const rootDivAltRe = new RegExp(
    `<div\\b[^>]*\\bclass=["'][^"']*\\b${sceneId}-root\\b[^"']*["'][^>]*\\bid=["']root["']`,
    'i'
  )
  if (!rootDivRe.test(html) && !rootDivAltRe.test(html)) {
    errors.push({
      sceneId,
      rule: 'root-contract',
      detail: `no <div id="root" class="${sceneId}-root" ...> found — both attributes must be on the same div`
    })
  }

  // Rule 1b: data-composition-id and data-duration on root
  const hostIdRe = new RegExp(`data-composition-id=["']${sceneId}["']`)
  if (!hostIdRe.test(html)) {
    errors.push({
      sceneId,
      rule: 'data-composition-id',
      detail: `no data-composition-id="${sceneId}" found`
    })
  }
  if (!/data-duration=["'][\d.]+["']/.test(html)) {
    errors.push({
      sceneId,
      rule: 'data-duration',
      detail: `no data-duration="<float>" found on root`
    })
  }

  // Rule 1c: window.__timelines["<scene-id>"] registration
  const tlKeyRe = new RegExp(`window\\.__timelines\\s*\\[\\s*["']${sceneId}["']\\s*\\]\\s*=`)
  if (!tlKeyRe.test(html)) {
    errors.push({
      sceneId,
      rule: 'timeline-registration',
      detail: `no window.__timelines["${sceneId}"] = ... line found (scene id must match verbatim)`
    })
  }

  // Recommended namespace prefix: scene_1 -> s1-; group_w2 -> g2- for shared nodes.
  // Used for fix hints and namespace health checks.
  const groupM = sceneId.match(/^group_w(\d+)$/)
  const m = sceneId.match(/(\d+)/)
  const sN = groupM ? `g${groupM[1]}-` : m ? `s${m[1]}-` : `s-`
  const sceneLocalHints =
    groupM && target.sceneIds.length
      ? `; logical-scene-only nodes may use ${target.sceneIds
          .map((sid) => `.${sid.replace(/^scene_/, 's')}-foo`)
          .join(' / ')}`
      : ''
  const wrapperAncestor = `.${sceneId}-root` // literal bug shape
  const fixHint = `plain .${sN}foo / #${sN}foo (no ancestor selector)${sceneLocalHints}`

  // Rule 2: CSS — <style> must not contain wrapper-ancestor selectors
  //
  // Shape: `.<scene-id>-root .foo` / `.<scene-id>-root #foo`. Preview / snapshot
  // keeps the wrapper through the bundler path, so the selector works there; but
  // `hyperframes render` takes the producer path, strips the wrapper, and every
  // selector misses, yielding a black scene. Historical bug: early product-launch-video
  // worker prompts taught agents to write selectors this way.
  //
  // Root styles go in `#root { ... }`. The compiler rewrites the authored root id
  // into an instance-safe selector; do not write `[data-composition-id="<scene-id>"]`,
  // or `npx hyperframes lint` reports composition_self_attribute_selector.
  //
  // Also ban id selector `#<scene-id>-root`: it is not a runtime contract; internal
  // elements use `#s<N>-foo`.
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style[^>]*>/gi)]
  for (const sb of styleBlocks) {
    const css = sb[1]
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')

    // 2a: wrapper-ancestor selector (`.<scene-id>-root` followed by whitespace/`>`/`+`/`~`/`,`/`.`/`#`)
    const escapedSceneId = escapeRegExp(sceneId)
    const wrapperRe = new RegExp(`\\.${escapedSceneId}-root(?=[\\s>+~,.#:\\[])`, 'g')
    const wrapperHits = [...stripped.matchAll(wrapperRe)]
    if (wrapperHits.length > 0) {
      errors.push({
        sceneId,
        rule: 'css-wrapper-ancestor',
        detail: `<style> uses ${wrapperAncestor} as an ancestor selector (${wrapperHits.length} hit(s)) — producer rendering strips that wrapper, so every selector misses. Use ${fixHint}; put root-level background / font styles (and any token overrides) on #root { ... } — base tokens are global in index.html's <head>.`
      })
    }

    // 2b: self data-composition-id selector triggers a CLI warning; root styles use #root.
    const selfAttrRe = new RegExp(
      `\\[\\s*data-composition-id\\s*=\\s*["']${escapedSceneId}["']\\s*\\]`,
      'g'
    )
    const selfAttrHits = [...stripped.matchAll(selfAttrRe)]
    if (selfAttrHits.length > 0) {
      errors.push({
        sceneId,
        rule: 'css-self-composition-selector',
        detail: `<style> uses [data-composition-id="${sceneId}"] selector (${selfAttrHits.length} hit(s)) — this triggers npx hyperframes lint composition_self_attribute_selector warning. Move root styles to #root { ... }; internal elements use .${sN}foo / #${sN}foo`
      })
    }

    // 2c: ban `#<scene-id>-root`; allow `#root`.
    const idSelectors = [...stripped.matchAll(/(^|[\s,>+~])#([a-zA-Z][\w-]*)/gm)]
    const banned = idSelectors.map((sm) => sm[2]).filter((id) => id === `${sceneId}-root`)
    if (banned.length > 0) {
      errors.push({
        sceneId,
        rule: 'css-scene-root-id-selector',
        detail: `<style> uses banned id selector: ${[...new Set(banned)].map((b) => `#${b}`).join(', ')} — root may only use #root; change internal elements to ${fixHint}`
      })
    }
  }

  // Rule 3: JS — <script> must not contain wrapper-ancestor selectors / #<scene-id>-root
  const scriptBlocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/gi)]
  for (const sb of scriptBlocks) {
    const js = sb[1]
    const stripped = js.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

    // 3a: string literal contains `.<scene-id>-root` as an ancestor
    const wrapperJsRe = new RegExp(
      `["'\`][^"'\`]*\\.${escapeRegExp(sceneId)}-root[\\s>+~,.#:\\[][^"'\`]*["'\`]`,
      'g'
    )
    const wrapperJsHits = [...stripped.matchAll(wrapperJsRe)]
    if (wrapperJsHits.length > 0) {
      errors.push({
        sceneId,
        rule: 'js-wrapper-ancestor',
        detail: `<script> string contains ${wrapperAncestor} ancestor selector: ${wrapperJsHits
          .slice(0, 3)
          .map((mm) => mm[0])
          .join(
            ', '
          )}${wrapperJsHits.length > 3 ? ` (+${wrapperJsHits.length - 3} more)` : ''} — producer rendering strips the wrapper. Use ${fixHint}`
      })
    }

    // 3b: string literal contains `#<scene-id>-root`
    const bannedJsRe = new RegExp(
      `["'\`][^"'\`]*#${escapeRegExp(sceneId)}-root\\b[^"'\`]*["'\`]`,
      'g'
    )
    const matches = [...stripped.matchAll(bannedJsRe)]
    if (matches.length > 0) {
      errors.push({
        sceneId,
        rule: 'js-scene-root-id-selector',
        detail: `<script> contains banned selector: ${matches
          .slice(0, 3)
          .map((mm) => mm[0])
          .join(
            ', '
          )}${matches.length > 3 ? ` (+${matches.length - 3} more)` : ''} — use ${fixHint}`
      })
    }

    // 3c: getElementById("<scene-id>-root")
    const banGEI = new RegExp(
      `getElementById\\(\\s*["'\`]${escapeRegExp(sceneId)}-root["'\`]\\s*\\)`,
      'g'
    )
    const geiMatches = [...stripped.matchAll(banGEI)]
    if (geiMatches.length > 0) {
      errors.push({
        sceneId,
        rule: 'js-scene-root-id-selector',
        detail: `<script> uses ${geiMatches[0][0]} — use document.querySelector("#root") or document.querySelector("#${sN}foo")`
      })
    }
  }

  // Rule 4: referenced public/ assets must exist
  const assetRefs = new Set()
  for (const m of html.matchAll(/\bpublic\/[A-Za-z0-9._/-]+/g)) {
    assetRefs.add(m[0])
  }
  for (const ref of assetRefs) {
    if (!existsSync(join(hyperframesDir, ref))) {
      errors.push({
        sceneId,
        rule: 'asset',
        detail: `reference "${ref}" does not exist under project-root/public/`
      })
    }
  }

  // Rule 5: forbidden patterns (CSS animation, Date.now(), etc.)
  const forbidden = [
    { re: /\btransition\s*:/i, name: 'CSS transition:', scope: 'style' },
    { re: /\banimation\s*:/i, name: 'CSS animation:', scope: 'style' },
    {
      re: /@font-face\b/i,
      name: '@font-face (declare in index.html, not in scene)',
      scope: 'style'
    },
    { re: /\bDate\.now\b/, name: 'Date.now()', scope: 'script' },
    { re: /\bMath\.random\b/, name: 'Math.random()', scope: 'script' },
    { re: /\bperformance\.now\b/, name: 'performance.now()', scope: 'script' },
    { re: /\brepeat\s*:\s*-1\b/, name: 'repeat: -1', scope: 'script' },
    { re: /\bfetch\s*\(/, name: 'fetch(', scope: 'script' }
  ]

  // CSS transition:/animation: and @font-face are PLV pre-flight conventions
  // (force all motion through one seekable GSAP timeline; declare fonts once in
  // index.html <head>), NOT hyperframes-core contract — core/determinism-rules.md
  // forbids none of them and adapters/css-animations.md actually supports seekable
  // CSS keyframes. Date.now/Math.random/performance.now/repeat:-1/fetch ARE core
  // determinism rules. The detail string says which so the agent doesn't go
  // cross-checking core for a rule that isn't there.
  const plvOnly = new Set(['CSS transition:', 'CSS animation:'])
  for (const f of forbidden) {
    const blocks = f.scope === 'style' ? styleBlocks : scriptBlocks
    for (const m of blocks) {
      if (f.re.test(m[1])) {
        const src = plvOnly.has(f.name)
          ? 'PLV pre-flight constraint (force GSAP tween; not a core contract; css-animations adapter supports seekable CSS)'
          : f.name.startsWith('@font-face')
            ? 'PLV constraint (@font-face belongs in index.html <head>)'
            : 'core determinism contract'
        errors.push({
          sceneId,
          rule: 'forbidden',
          detail: `<${f.scope}> contains ${f.name} — ${src}`
        })
        break
      }
    }
  }

  // Rule 6: asset paths must not have a leading slash
  if (/\bsrc=["']\/public\//.test(html) || /\burl\(["']?\/public\//.test(html)) {
    errors.push({
      sceneId,
      rule: 'asset-path',
      detail: `asset reference uses leading slash "/public/..." — must be "public/..." with no leading slash`
    })
  }

  // Rule 6a: NO <video> inside a scene composition — ever.
  // Framework rule (hyperframes-core variables-and-media.md, NON-NEGOTIABLE):
  // the runtime only registers + drives media that is a DIRECT child of the
  // host root in index.html. A <video> nested in a scene <template> is never
  // seeked/decoded → renders blank, and no other gate can see it (only
  // per-frame snapshots). Footage is declared on the poster <img> instead
  // (data-video-src + optional data-video-offset/-duration/-media-start/-loop)
  // and hoist-videos.mjs assembles the real host-root <video> in Step 7.
  for (const vm of html.matchAll(/<video\b[^>]*>/gi)) {
    const tag = vm[0].length > 120 ? vm[0].slice(0, 117) + '...' : vm[0]
    errors.push({
      sceneId,
      rule: 'video-in-scene',
      detail: `${tag} — <video> must NOT appear inside a scene (nested video is never seeked/decoded by the runtime and renders BLANK at render time). Author the poster <img class="clip"> in the slot and declare the footage on it: data-video-src="public/<clip>" [data-video-offset / data-video-duration / data-video-media-start / data-video-loop="off"]. hoist-videos.mjs mounts the real <video> at the index.html host root deterministically.`
    })
  }
  // Rule 6a-bis: data-video-src declarations must be valid (the hoist step
  // consumes them; catching shape errors here keeps failures at Step 6).
  for (const im of html.matchAll(/<img\b[^>]*\bdata-video-src\s*=\s*"([^"]*)"[^>]*>/gi)) {
    const src = im[1]
    const tag = im[0].length > 120 ? im[0].slice(0, 117) + '...' : im[0]
    if (!/^public\//.test(src)) {
      errors.push({
        sceneId,
        rule: 'video-decl-bad-src',
        detail: `${tag} — data-video-src must be a relative public/ path (got "${src}").`
      })
    }
    for (const numAttr of ['data-video-offset', 'data-video-duration', 'data-video-media-start']) {
      const m = im[0].match(new RegExp(`${numAttr}\\s*=\\s*"([^"]*)"`, 'i'))
      if (m && !(isFinite(parseFloat(m[1])) && parseFloat(m[1]) >= 0)) {
        errors.push({
          sceneId,
          rule: 'video-decl-bad-number',
          detail: `${tag} — ${numAttr}="${m[1]}" is not a non-negative number.`
        })
      }
    }
  }

  // Rule 6b: comments must not contain literal HTML opening tags
  // `npx hyperframes lint` scans <template> / <style> / <script> with regexes, so
  // literal tags in comments can be mistaken for real tags and create false structure errors.
  // Catch this during preflight to avoid a 90s finalize lint-debug loop.
  if (/<!--[^>]*<(template|style|script)[> ][^>]*-->/.test(html)) {
    errors.push({
      sceneId,
      rule: 'literal-tag-in-comment',
      detail: `comment contains literal <template>/<style>/<script> — this pollutes npx hyperframes lint regex scanning; escape < as &lt; or rewrite as plain text`
    })
  }
}

for (const logicalSceneId of sceneIds) {
  const entry = sceneEntries.get(logicalSceneId) || {}

  // Rule 7 (fatal once metadata is present): rank-1 uniqueness + forbidden_with conflicts
  //
  // Source = design-system/chunks/index.json.components[].{rank, forbidden_with}
  // (written by emit-chunks.mjs, originally declared by YAML frontmatter in preset
  // components/<id>.md). Older presets without frontmatter leave componentMeta empty,
  // so this rule silently skips and preserves backward compatibility.
  if (componentMeta.size === 0) continue
  const cited = (entry.design_chunks?.components || []).map(componentIdFromPath).filter(Boolean)

  const rank1 = cited.filter((id) => componentMeta.get(id)?.rank === 1)
  if (rank1.length > 1) {
    errors.push({
      sceneId: logicalSceneId,
      rule: 'rank-1-overload',
      detail: `scene declares ${rank1.length} focal (rank=1) components: [${rank1.join(', ')}] — at most 1 rank-1 element per scene. Split into separate scenes or downgrade one to rank=2 (supporting) / rank=3 (chrome).`
    })
  }

  const citedSet = new Set(cited)
  for (const id of cited) {
    const meta = componentMeta.get(id)
    if (!meta) continue
    for (const forbidden of meta.forbidden_with) {
      if (citedSet.has(forbidden) && id < forbidden) {
        errors.push({
          sceneId: logicalSceneId,
          rule: 'forbidden-with',
          detail: `scene cites components "${id}" and "${forbidden}" together — preset declares them mutually exclusive (forbidden_with). Drop one.`
        })
      }
    }
  }
}

// ---------- report ----------
const anomalyByScene = new Map()
for (const a of anomalies) {
  if (!anomalyByScene.has(a.sceneId)) anomalyByScene.set(a.sceneId, [])
  anomalyByScene.get(a.sceneId).push(a)
}

if (errors.length === 0) {
  console.log(
    `✓ all ${visualTargets.length} visual composition(s) for ${sceneIds.length} logical scene(s) pass pre-finalize checks`
  )
  if (anomalies.length > 0) {
    console.log(`\nanomalies (non-fatal):`)
    for (const [sid, list] of anomalyByScene) {
      console.log(`  ${sid}:`)
      for (const a of list) console.log(`    [${a.rule}] ${a.detail}`)
    }
  }
  process.exit(0)
}

// Group by sceneId for readability.
const bySceneId = new Map()
for (const e of errors) {
  if (!bySceneId.has(e.sceneId)) bySceneId.set(e.sceneId, [])
  bySceneId.get(e.sceneId).push(e)
}

console.error(
  `✗ ${errors.length} fatal violation(s) across ${bySceneId.size} composition/scene id(s):\n`
)
for (const [sceneId, list] of bySceneId) {
  console.error(`  ${sceneId}:`)
  for (const e of list) {
    console.error(`    [${e.rule}] ${e.detail}`)
  }
}
if (anomalies.length > 0) {
  console.error(`\nanomalies (non-fatal):`)
  for (const [sid, list] of anomalyByScene) {
    console.error(`  ${sid}:`)
    for (const a of list) console.error(`    [${a.rule}] ${a.detail}`)
  }
}
console.error(
  `\n  Fix the corresponding visual HTML (or have the orchestrator re-dispatch the worker) and rerun finalize.`
)
process.exit(1)
