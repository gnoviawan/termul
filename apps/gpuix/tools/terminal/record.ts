/**
 * Records the fixture through Termul's own `/terminal/ws` client: spawns the
 * fixture shell at 80x24 on the server named by `TERMUL_SERVER_URL`, types
 * each step, and writes every output byte to `fixtures/session.bin` plus the
 * stream offset after each step to `fixtures/session.json`. Bundled by
 * `bundle.ts` and run by `demo.ts --record`, which passes the two paths
 * (a bundle's `import.meta.dir` is `dist/terminal`, not this folder).
 *
 * bun dist/terminal/record.js <session.bin> <session.json>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readClientConfig } from '../../src/env/config'
import { loadTerminalApi, spawnSession } from '../../src/terminal/transport'
import {
  FIXTURE_COLS,
  FIXTURE_ROWS,
  FIXTURE_STEPS,
  PROJECT_DIR,
  PROJECT_ID,
  SHELL_SPAWN,
  seedFixtureDir
} from './fixture'

const [bytesPath, checkpointsPath] = process.argv.slice(2)
if (!bytesPath || !checkpointsPath) throw new Error('usage: record.js <session.bin> <session.json>')
seedFixtureDir()
const api = await loadTerminalApi(readClientConfig())
const chunks: Uint8Array[] = []
let length = 0
const session = await spawnSession(api, {
  ...SHELL_SPAWN,
  projectId: PROJECT_ID,
  cwd: PROJECT_DIR,
  cols: FIXTURE_COLS,
  rows: FIXTURE_ROWS,
  onData: (bytes) => {
    chunks.push(bytes)
    length += bytes.length
  }
})
await Bun.sleep(500)
const checkpoints: Record<string, number> = { prompt: length }
for (const step of FIXTURE_STEPS) {
  session.write(step.input.endsWith('\r') ? step.input : `${step.input}\r`)
  await Bun.sleep(step.waitMs)
  checkpoints[step.name] = length
}
await Bun.sleep(300)
session.dispose()
await session.kill()

const out = new Uint8Array(length)
let offset = 0
for (const chunk of chunks) {
  out.set(chunk, offset)
  offset += chunk.length
}
mkdirSync(path.dirname(bytesPath), { recursive: true })
writeFileSync(bytesPath, out)
writeFileSync(checkpointsPath, `${JSON.stringify(checkpoints, null, 2)}\n`)
console.log(`recorded ${out.length} bytes to ${bytesPath}`)
process.exit(0)
