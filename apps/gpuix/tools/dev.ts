/**
 * Dev loop: bundle, run the bundle under `bun --hot`, rebuild when a source
 * file changes. `bun --hot` reloads the entry when `dist/main.js` is rewritten
 * and remounts the tree in the same window (state resets; GPUIX has no React
 * Refresh on desktop).
 */

import { watch } from 'node:fs'
import path from 'node:path'
import { APP_DIR, buildClient, REPO_DIR } from '../build'

const WATCHED = [
  path.join(APP_DIR, 'src'),
  path.join(REPO_DIR, 'src/renderer'),
  path.join(REPO_DIR, 'src/shared')
]
const DEBOUNCE_MS = 120

async function build(): Promise<boolean> {
  const started = performance.now()
  const result = await buildClient()
  for (const line of result.logs) console.error(line)
  console.log(
    `[dev] ${result.ok ? 'built' : 'build failed'} in ${Math.round(performance.now() - started)} ms`
  )
  return result.ok
}

if (!(await build())) process.exit(1)

const child = Bun.spawn(['bun', '--hot', path.join(APP_DIR, 'dist/main.js')], {
  cwd: APP_DIR,
  stdio: ['inherit', 'inherit', 'inherit'],
  env: process.env
})
child.exited.then((code) => process.exit(code))

let timer: ReturnType<typeof setTimeout> | null = null
for (const dir of WATCHED) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (file && /\.(test|spec)\.tsx?$/.test(file)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void build(), DEBOUNCE_MS)
  })
}
