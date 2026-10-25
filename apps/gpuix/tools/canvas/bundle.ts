/**
 * The pinned FigCraft web bundle for canvas checks. The test termul-server is a release build
 * without the bundle (it answers BUNDLE_MISSING) and release builds ignore the dev override
 * directory, so the checks fetch the bundle `canvas/figcraft.pin` names into their own state dir
 * and `bundle-proxy.ts` serves it. Fetching, the sha256 check and extraction are the repo's own
 * `scripts/canvas/fetch-figcraft-bundle.mjs`; this only skips the download when the directory
 * already holds the pinned bundle.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_DIR } from '../../build'

const PIN_FILE = path.join(REPO_DIR, 'canvas/figcraft.pin')
const FETCH_SCRIPT = path.join(REPO_DIR, 'scripts/canvas/fetch-figcraft-bundle.mjs')
const STAMP = '.pinned-sha256'

export function pinnedSha256(): string {
  const line = readFileSync(PIN_FILE, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('sha256='))
  if (!line) throw new Error(`${PIN_FILE} has no sha256= line`)
  return line.slice('sha256='.length).trim()
}

/** The bundle root (holds index.html) under `dir`, fetched and verified when missing or stale. */
export async function ensureFigcraftBundle(dir: string): Promise<string> {
  const sha = pinnedSha256()
  const stamp = path.join(dir, STAMP)
  if (existsSync(path.join(dir, 'index.html')) && existsSync(stamp)) {
    if (readFileSync(stamp, 'utf8').trim() === sha) return dir
  }
  const fetch = Bun.spawn(['node', FETCH_SCRIPT, '--out', dir], {
    cwd: REPO_DIR,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [out, err, code] = await Promise.all([
    new Response(fetch.stdout).text(),
    new Response(fetch.stderr).text(),
    fetch.exited
  ])
  if (code !== 0) throw new Error(`fetch-figcraft-bundle failed (${code}): ${err || out}`)
  if (!existsSync(path.join(dir, 'index.html'))) {
    throw new Error(`fetch-figcraft-bundle wrote no index.html to ${dir}`)
  }
  writeFileSync(stamp, `${sha}\n`)
  console.error(`[canvas-bundle] ${out.trim()}`)
  return dir
}
