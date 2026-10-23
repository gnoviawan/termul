/** Bundle the terminal pane scene into `dist/terminal-scene/` with the client's resolver and overrides. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { APP_DIR, buildClient } from '../../../build'

export const SCENE_OUT = path.join(APP_DIR, 'dist/terminal-scene')

/** Shared files a native override replaces must not reach the bundle. */
const MUST_NOT_BUNDLE = [
  'node_modules/@xterm/xterm/',
  'node_modules/@xterm/addon-',
  'src/renderer/components/terminal/ConnectedTerminal.tsx',
  'src/renderer/components/terminal/TerminalAssistPanel.tsx',
  'src/renderer/hooks/use-terminal-clipboard.ts',
  'src/renderer/components/terminal/use-terminal-fit.ts',
  'src/renderer/components/terminal/terminal-factory.ts',
  'src/renderer/components/terminal/terminal-renderer-pool.ts',
  'src/renderer/components/terminal/xterm-touch-tap-focus.ts',
  'src/renderer/components/terminal/XTerminal.tsx'
]

async function bundle(file: string): Promise<void> {
  const result = await buildClient(path.join(import.meta.dir, file), SCENE_OUT)
  for (const line of result.logs) console.error(line)
  if (!result.ok) throw new Error(`terminal scene build failed: ${file}`)
}

export async function buildScene(): Promise<string> {
  await Promise.all([bundle('main.ts'), bundle('boot.tsx')])
  const map = JSON.parse(readFileSync(path.join(SCENE_OUT, 'boot.js.map'), 'utf8')) as {
    sources: string[]
  }
  const leaked = MUST_NOT_BUNDLE.filter((needle) => map.sources.some((s) => s.includes(needle)))
  if (leaked.length)
    throw new Error(`terminal scene bundles DOM terminal code: ${leaked.join(', ')}`)
  return path.join(SCENE_OUT, 'main.js')
}

if (import.meta.main) {
  const started = performance.now()
  const entry = await buildScene()
  console.log(
    `built ${path.relative(APP_DIR, entry)} in ${Math.round(performance.now() - started)} ms`
  )
}
