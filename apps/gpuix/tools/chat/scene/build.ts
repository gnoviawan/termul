/**
 * Bundle the transcript scene into `dist/chat-scene/`: `main.js` (environment
 * seam, Bun-typed) loads `boot.js` (the app side) at runtime.
 *
 * Same plugins as `buildClient()` plus loaders for two Vite features the
 * chat rows reach and `build.ts` does not handle yet: the `?raw` suffix
 * (`ToolCallCard`, the agent registry) and eager raw `import.meta.glob` (the
 * agent and material icon catalogs).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { BunPlugin } from 'bun'
import { APP_DIR, compatPlugin, overridesPlugin, REPO_DIR, termulResolver } from '../../../build'
import { gpuixUiAliases } from '../../ui/alias'

export const SCENE_OUT = path.join(APP_DIR, 'dist/chat-scene')
const RENDERER_DIR = path.join(REPO_DIR, 'src/renderer')

/** `import svg from './x.svg?raw'` -> the file's text as the default export. */
export function rawPlugin(): BunPlugin {
  return {
    name: 'vite-raw-suffix',
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (args) => {
        const file = args.path.slice(0, -'?raw'.length)
        return {
          path: file.startsWith('@/')
            ? path.join(RENDERER_DIR, file.slice(2))
            : path.resolve(path.dirname(args.importer), file),
          namespace: 'raw'
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
        loader: 'js',
        contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`
      }))
    }
  }
}

const GLOB_ROOTS: Record<string, string> = {
  '@/': `${RENDERER_DIR}/`,
  '@material-icons/': `${path.join(path.dirname(Bun.resolveSync('material-icon-theme/package.json', REPO_DIR)), 'icons')}/`
}
const GLOB_CALL = /import\.meta\.glob(?:<[^>]*>)?\(\s*'([^']+)'\s*,\s*\{[^}]*\}\s*\)/g

/**
 * Vite's eager raw `import.meta.glob(pattern, { eager, query: '?raw', import: 'default' })`
 * -> an object literal of file text keyed by repo-relative path, the shape Vite returns.
 */
export function globPlugin(): BunPlugin {
  return {
    name: 'vite-eager-raw-glob',
    setup(build) {
      build.onLoad({ filter: /(agent-icon-catalog|material-icon-catalog)\.ts$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8').replace(GLOB_CALL, (_call, pattern: string) => {
          const prefix = Object.keys(GLOB_ROOTS).find((key) => pattern.startsWith(key))
          const absolute = prefix ? GLOB_ROOTS[prefix] + pattern.slice(prefix.length) : pattern
          const dir = path.dirname(absolute)
          const entries = [...new Bun.Glob(path.basename(absolute)).scanSync({ cwd: dir })].map((name) => {
            const file = path.join(dir, name)
            return `${JSON.stringify(`/${path.relative(REPO_DIR, file)}`)}: ${JSON.stringify(readFileSync(file, 'utf8'))}`
          })
          return `({${entries.join(',')}})`
        })
        return { loader: 'ts', contents: source }
      })
    }
  }
}

async function bundle(file: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, file)],
    outdir: SCENE_OUT,
    target: 'bun',
    format: 'esm',
    sourcemap: 'linked',
    external: ['@gpuix/react', '@gpuix/react/*', '@gpuix/native', '@gpuix/native/*'],
    plugins: [rawPlugin(), globPlugin(), compatPlugin(), gpuixUiAliases(), overridesPlugin(), termulResolver()],
    naming: '[name].[ext]'
  })
  for (const log of result.logs) console.error(String(log))
  if (!result.success) throw new Error(`chat scene build failed: ${file}`)
}

export async function buildScene(): Promise<string> {
  await Promise.all([bundle('main.ts'), bundle('boot.tsx')])
  return path.join(SCENE_OUT, 'main.js')
}

if (import.meta.main) {
  const started = performance.now()
  const entry = await buildScene()
  console.log(`built ${path.relative(APP_DIR, entry)} in ${Math.round(performance.now() - started)} ms`)
}
