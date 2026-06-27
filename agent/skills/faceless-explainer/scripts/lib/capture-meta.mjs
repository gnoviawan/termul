// capture-meta.mjs — shared capture-ingest helpers.
//
// Both derive-context-pack.mjs (Phase 1 post-processor) and build-design.mjs
// (Phase 1b) read the same `hyperframes capture` output. This module holds the
// parsing they would otherwise each re-implement, so the algorithms stay in
// lockstep (previously the source-URL discovery was duplicated byte-for-byte in
// both files and could drift).

import fs from 'node:fs'
import path from 'node:path'

/**
 * Discover the captured page's source URL.
 *
 * `hyperframes capture` writes the URL into its agent-scaffolding files
 * (CLAUDE.md / AGENTS.md / .cursorrules); we grep those for the first URL.
 * Fallback: reconstruct from meta.id (a host slug like "heygen.com-video").
 *
 * @param {string} captureDir  capture output dir (contains the scaffold files + meta.json)
 * @param {{id?: string}|null} meta  parsed capture/meta.json (for the fallback)
 * @returns {string} the source URL, or "" if none could be discovered
 */
export function discoverSourceUrl(captureDir, meta) {
  for (const f of ['CLAUDE.md', 'AGENTS.md', '.cursorrules']) {
    let txt = ''
    try {
      txt = fs.readFileSync(path.join(captureDir, f), 'utf8')
    } catch {
      // scaffold file absent — try the next one
    }
    const m = txt.match(/https?:\/\/[\w.-]+(?:\/[^\s)"'`]*)?/)
    if (m) return m[0]
  }
  if (meta?.id) {
    const host = String(meta.id).replace(/-[a-z]+$/, '')
    return `https://${host}/`
  }
  return ''
}
