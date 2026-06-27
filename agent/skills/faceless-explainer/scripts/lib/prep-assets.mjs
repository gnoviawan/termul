// prep.mjs concern module — capture media + brand fonts → the HyperFrames
// project's public/ tree, plus the @font-face block extraction. Pure file I/O;
// no section_plan / group_spec knowledge. Split out of prep.mjs (Steps 2/2b/2c)
// to keep the orchestrator lean.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

// `.bin` is the capture-stage fallback name for images with unrecognized MIME
// (typically image/* with a missing or CDN-rewritten Content-Type). Downstream
// Phase 4b workers reference them as <img src>; browsers render by magic bytes
// and almost all display correctly. Include it in the allowlist to avoid orphaning files.
const ASSET_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.bin',
  // Video extensions — Phase 3 frequently quotes hero/demo .mp4 from the
  // capture. Forgetting these forces Phase 4b workers to substitute poster
  // .webp, losing motion fidelity. Keep in sync with the playable formats
  // hyperframes-core accepts in <video>/clip sub-comps.
  '.mp4',
  '.mov',
  '.webm'
])

const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf'])

// Step 2: copy capture image/video media → public/. hyperframes capture writes
// assets/ + screenshots/ + extracted/ under captureDir; we want only the media
// (assets/ + screenshots/), not the JSON manifests under extracted/. First-wins
// on basename collisions (the skipped path is reported, never silently lost).
export function copyCaptureAssets(captureDir, publicDir) {
  mkdirSync(publicDir, { recursive: true })
  const collisions = []
  let copied = 0

  function walk(dir) {
    if (!existsSync(dir)) return
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ASSET_EXTS.has(extname(ent.name).toLowerCase())) {
        const target = join(publicDir, ent.name)
        if (existsSync(target)) {
          collisions.push({ kept: target, skipped: p })
        } else {
          copyFileSync(p, target)
          copied++
        }
      }
    }
  }
  walk(join(captureDir, 'assets'))
  walk(join(captureDir, 'screenshots'))
  return { copied, collisions }
}

// Step 2b: copy self-hosted brand fonts (Phase 1b's download-fonts.mjs writes
// them into design-system/fonts/) → public/fonts/ so the renderer resolves the
// @font-face url()s that index.html declares.
export function copyBrandFonts(designSystemDir, publicDir) {
  const fontsSrcDir = join(designSystemDir, 'fonts')
  let fontsCopied = 0
  if (existsSync(fontsSrcDir)) {
    const fontsDestDir = join(publicDir, 'fonts')
    mkdirSync(fontsDestDir, { recursive: true })
    for (const ent of readdirSync(fontsSrcDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue
      if (!FONT_EXTS.has(extname(ent.name).toLowerCase())) continue
      const src = join(fontsSrcDir, ent.name)
      const dest = join(fontsDestDir, ent.name)
      if (!existsSync(dest)) {
        copyFileSync(src, dest)
        fontsCopied++
      }
    }
  }
  return fontsCopied
}

// Step 2c: pull the @font-face block out of design.html (download-fonts.mjs wraps
// its injection with two comment anchors), rewrite url('fonts/<file>') →
// url('public/fonts/<file>') so paths resolve against the project root, and return
// it for group_spec.font_face_css. @font-face is global by spec and cannot be
// class-scoped — Phase 4c declares it once at the document root.
export function extractFontFaceCss(designSystemDir) {
  let fontFaceCss = ''
  const designHtmlPath = join(designSystemDir, 'design.html')
  if (existsSync(designHtmlPath)) {
    const designHtml = readFileSync(designHtmlPath, 'utf8')
    const m = designHtml.match(
      /\/\*\s*===\s*auto-injected by download-fonts\.mjs\s*===\s*\*\/([\s\S]*?)\/\*\s*===\s*end download-fonts\.mjs block\s*===\s*\*\//
    )
    if (m) {
      fontFaceCss = m[1].trim().replace(/url\(\s*(['"]?)fonts\//g, 'url($1public/fonts/')
    }
  }
  return fontFaceCss
}
