#!/usr/bin/env node
/**
 * emit-chunks.mjs
 *
 * Parse a finished design.html (from build-design.mjs) and emit paste-ready
 * chunks under <dir>/chunks/. Downstream phases (visual-design plan, scene
 * workers) read these chunks instead of grepping the monolithic design.html,
 * cutting their must-read load from ~12 KB to ~1-3 KB per file consumed.
 *
 * Usage:
 *   node emit-chunks.mjs <design-system-dir>
 *
 * Inputs:
 *   <dir>/design.html       — must exist (produced by build-design.mjs)
 *
 * Outputs:
 *   <dir>/chunks/tokens.css                     — :root { ... } from §ROOT block
 *   <dir>/chunks/easings.js                     — EASE / DUR const from §MOTION block
 *   <dir>/chunks/voice.md                       — DOM-copy register from §VOICE block
 *   <dir>/chunks/composition-hints.md           — §H rules (surface/material/colour) — plan agent reads this
 *   <dir>/chunks/components/<id>.html           — one file per §COMPONENT block
 *   <dir>/chunks/index.json                     — manifest (preset, paths, component list + frontmatter)
 *
 * Exit 0 on success; 1 if design.html or required ROOT/MOTION/VOICE markers are missing.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const outDir = path.resolve(process.argv[2] || './design-system')
const designHtmlPath = path.join(outDir, 'design.html')
const chunksDir = path.join(outDir, 'chunks')
const componentsDir = path.join(chunksDir, 'components')

if (!fs.existsSync(designHtmlPath)) {
  console.error(`✗ emit-chunks: ${designHtmlPath} not found — run build-design.mjs first`)
  process.exit(1)
}

const html = fs.readFileSync(designHtmlPath, 'utf8')

fs.mkdirSync(chunksDir, { recursive: true })
fs.mkdirSync(componentsDir, { recursive: true })

function htmlDecode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

// Strip an optional ```<lang> ... ``` markdown code fence — build-design wraps
// component bodies in fences for the design.html UI; chunks need raw HTML.
function stripCodeFence(s) {
  let t = s
  t = t.replace(/^\s*```[a-z]*\s*\n?/i, '')
  t = t.replace(/\n?\s*```\s*$/i, '')
  return t
}

// design.html's AGENT NOTE comment + <p class="ds-prose"> docs blocks contain
// literal references to these markers (e.g. `grep <!-- ROOT-START -->`) which
// would false-positive a naive whole-file regex. Anchor every match to a
// <pre class="ds-code"> opener — that's where the paste-ready blocks live.
const PRE_OPEN = `<pre[^>]*class=["']ds-code["'][^>]*>\\s*`

// ─── 1. tokens.css ────────────────────────────────────────────────
const rootMatch = html.match(
  new RegExp(`${PRE_OPEN}<!--\\s*ROOT-START\\s*-->([\\s\\S]*?)<!--\\s*ROOT-END\\s*-->`)
)
if (!rootMatch) {
  console.error(
    '✗ emit-chunks: missing <pre class="ds-code"><!-- ROOT-START --> ... <!-- ROOT-END --> block in design.html'
  )
  process.exit(1)
}
const tokensCss = htmlDecode(rootMatch[1]).trim()
fs.writeFileSync(path.join(chunksDir, 'tokens.css'), tokensCss + '\n')

// ─── 2. easings.js ────────────────────────────────────────────────
const motionMatch = html.match(
  new RegExp(`${PRE_OPEN}<!--\\s*MOTION-START\\s*-->([\\s\\S]*?)<!--\\s*MOTION-END\\s*-->`)
)
if (!motionMatch) {
  console.error(
    '✗ emit-chunks: missing <pre class="ds-code"><!-- MOTION-START --> ... <!-- MOTION-END --> block in design.html'
  )
  process.exit(1)
}
const easingsJs = htmlDecode(motionMatch[1]).trim()
fs.writeFileSync(path.join(chunksDir, 'easings.js'), easingsJs + '\n')

// ─── 3. voice.md ──────────────────────────────────────────────────
// §5 ships a paste-ready register for Phase 4b workers writing on-screen copy
// (headline / chip / button text). Narrator scripts are TTS-bound and stay in
// Phase 2 — voice.md never enters that path.
const voiceMatch = html.match(
  new RegExp(`${PRE_OPEN}<!--\\s*VOICE-START\\s*-->([\\s\\S]*?)<!--\\s*VOICE-END\\s*-->`)
)
if (!voiceMatch) {
  console.error(
    '✗ emit-chunks: missing <pre class="ds-code"><!-- VOICE-START --> ... <!-- VOICE-END --> block in design.html'
  )
  process.exit(1)
}
const voiceMd = htmlDecode(voiceMatch[1]).trim()
fs.writeFileSync(path.join(chunksDir, 'voice.md'), voiceMd + '\n')

// ─── 3.5 composition-hints.md ─────────────────────────────────────
// §H ships scene-composition rules (surface contract, material avoidance, 60/30/10
// color placement). The plan agent reads this when picking
// components for a scene — without it, peoples-style hard rules (single
// triple-stamp per plate, cream-frame only on dark surfaces, …) wouldn't reach
// anyone. Presets without a §H emit a stub block so the file always exists and
// plan agent's must-read path is uniform across presets.
const hintsMatch = html.match(
  new RegExp(`${PRE_OPEN}<!--\\s*HINTS-START\\s*-->([\\s\\S]*?)<!--\\s*HINTS-END\\s*-->`)
)
let hintsFile = null
if (hintsMatch) {
  const hintsMd = htmlDecode(hintsMatch[1]).trim()
  fs.writeFileSync(path.join(chunksDir, 'composition-hints.md'), hintsMd + '\n')
  hintsFile = 'chunks/composition-hints.md'
}

// ─── 3.6 type-roles.md ────────────────────────────────────────────
// §T type-role atlas (optional). Phase 4b scene worker reads on demand when
// text outside §6 components is needed — paste-ready markdown with per-role
// metadata, the §I CSS rule, and a sample snippet. Presets without §T → no
// file written, index.json's type_roles_file = null.
const typeRolesMatch = html.match(
  new RegExp(`${PRE_OPEN}<!--\\s*TYPE-ROLES-START\\s*-->([\\s\\S]*?)<!--\\s*TYPE-ROLES-END\\s*-->`)
)
let typeRolesFile = null
let typeRolesBytes = 0
if (typeRolesMatch) {
  const typeRolesMd = htmlDecode(typeRolesMatch[1]).trim()
  fs.writeFileSync(path.join(chunksDir, 'type-roles.md'), typeRolesMd + '\n')
  typeRolesFile = 'chunks/type-roles.md'
  typeRolesBytes = Buffer.byteLength(typeRolesMd)
}

// ─── 4. components ────────────────────────────────────────────────
// Component blocks live inside <pre class="ds-code">...</pre> with HTML-entity-
// escaped markers (so design.html renders the markers as visible text for human
// readers). Match only when anchored to a ds-code <pre> opener to avoid the
// docs paragraph that explains the marker convention with a literal placeholder.
const compRe = new RegExp(
  `${PRE_OPEN}&lt;!--\\s*COMPONENT:\\s*([a-z0-9-]+)\\s*--&gt;([\\s\\S]*?)&lt;!--\\s*\\/COMPONENT\\s*--&gt;`,
  'g'
)
// designhtml-class presets (peoples-platform, …) emit a COMPONENT-META line right
// after the COMPONENT marker, carrying frontmatter fields (surface / composes /
// role / avoids_same_scene / slots, …). Pluck it out before the body is treated
// as raw HTML, then spread the parsed JSON into the index.json entry so the plan
// agent can filter components by surface/role without opening each .html file.
// Legacy presets without frontmatter skip emission → meta stays null → entry
// stays {id, file} as before.
const componentMetaRe = /^\s*<!--\s*COMPONENT-META:\s*(\{[\s\S]*?\})\s*-->\s*\r?\n?/
const components = []
let cm
while ((cm = compRe.exec(html)) !== null) {
  const id = cm[1]
  let body = htmlDecode(cm[2])
  let meta = null
  const metaMatch = body.match(componentMetaRe)
  if (metaMatch) {
    try {
      meta = JSON.parse(metaMatch[1])
    } catch (e) {
      console.error(
        `! emit-chunks: component '${id}' has COMPONENT-META but JSON is invalid (${e.message}); ignoring`
      )
    }
    body = body.slice(metaMatch[0].length)
  }
  body = stripCodeFence(body).trim()
  fs.writeFileSync(path.join(componentsDir, `${id}.html`), body + '\n')
  components.push({
    id,
    file: `chunks/components/${id}.html`,
    size: Buffer.byteLength(body),
    meta
  })
}

if (components.length === 0) {
  console.error('✗ emit-chunks: no COMPONENT blocks found — design.html may be malformed or empty')
  process.exit(1)
}

// ─── 5. index.json (manifest) ─────────────────────────────────────
// Parse the AGENT NOTE comment for preset / source URL so downstream phases
// can route on preset without re-parsing the HTML themselves.
let preset = null
let source_url = null
const agentNote = html.match(/<!--[^>]*AGENT NOTE[\s\S]*?-->/)
if (agentNote) {
  const note = agentNote[0]
  const ps = note.match(/Style preset:\s*([^\n(]+?)\s*(?:\([^)]+\))?\s*$/m)
  const su = note.match(/Brand DNA from:\s*(\S+)/)
  if (ps) preset = ps[1].trim()
  if (su) source_url = su[1].trim()
}

// ─── 4.6 caption-skin.html (optional preset-local caption skin) ───
// A preset MAY ship its own pre-baked, brand-tokenized caption skin at
// style-presets/<preset>/caption-skin.html. When present, copy it into chunks/ so
// build-captions-html.mjs can use it as the project's caption SOURCE (a second source
// alongside the registry caption-* skins). Absent → registry skins, exactly as before.
let captionSkinFile = null
if (preset) {
  const skinSrc = path.resolve(__dirname, '..', 'style-presets', preset, 'caption-skin.html')
  if (fs.existsSync(skinSrc)) {
    fs.copyFileSync(skinSrc, path.join(chunksDir, 'caption-skin.html'))
    captionSkinFile = 'chunks/caption-skin.html'
  }
}

const index = {
  generated_at: new Date().toISOString(),
  source_url,
  preset,
  tokens_file: 'chunks/tokens.css',
  easings_file: 'chunks/easings.js',
  voice_file: 'chunks/voice.md',
  // hints_file is null when the preset doesn't declare §H. Plan agent treats null
  // as "no preset-level composition contract — pick by component id only".
  hints_file: hintsFile,
  // type_roles_file is null when preset declares no §T. Worker reads on demand
  // (paths flow through prep.mjs → dispatch).
  type_roles_file: typeRolesFile,
  // caption_skin_file is null unless the preset ships style-presets/<preset>/caption-skin.html.
  // When set, build-captions-html.mjs uses it as the caption source (preferred over registry
  // caption-* skins); null → registry skin scoring, as before.
  caption_skin_file: captionSkinFile,
  components: components.map(({ id, file, meta }) =>
    // Spread frontmatter (surface / composes / role / avoids_same_scene / slots)
    // alongside id+file. Plan agent reads these without opening component .html.
    meta ? { id, file, ...meta } : { id, file }
  )
}
fs.writeFileSync(path.join(chunksDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')

// ─── 6. report ────────────────────────────────────────────────────
const fmt = (b) => (b / 1024).toFixed(1)
const tokenBytes = Buffer.byteLength(tokensCss)
const easingBytes = Buffer.byteLength(easingsJs)
const voiceBytes = Buffer.byteLength(voiceMd)
const hintsBytes = hintsFile ? Buffer.byteLength(htmlDecode(hintsMatch[1]).trim()) : 0
const compBytes = components.reduce((sum, c) => sum + c.size, 0)
const designBytes = Buffer.byteLength(html)
const chunksBytes = tokenBytes + easingBytes + voiceBytes + hintsBytes + typeRolesBytes + compBytes

console.log(`✓ ${path.relative(process.cwd(), chunksDir)}/`)
console.log(`  tokens.css         ${fmt(tokenBytes)} KB`)
console.log(`  easings.js         ${fmt(easingBytes)} KB`)
console.log(`  voice.md           ${fmt(voiceBytes)} KB`)
if (hintsFile) console.log(`  composition-hints.md  ${fmt(hintsBytes)} KB`)
if (typeRolesFile) console.log(`  type-roles.md      ${fmt(typeRolesBytes)} KB`)
if (captionSkinFile) console.log(`  caption-skin.html  (preset-local caption source)`)
console.log(`  components/        ${components.length} files`)
for (const c of components) {
  console.log(`    ${c.id}.html  (${fmt(c.size)} KB)`)
}
console.log(`  index.json         lists ${components.length} components (preset=${preset || '?'})`)
console.log(
  `  totals             chunks ${fmt(chunksBytes)} KB vs design.html ${fmt(designBytes)} KB (~${Math.round((chunksBytes / designBytes) * 100)}% of source)`
)
