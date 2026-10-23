/**
 * Loaders for two Vite features the chat composer reaches and `build.ts` does
 * not handle yet: the `?raw` suffix and eager raw `import.meta.glob`. Same
 * plugins as gpuix/o2's tools/chat/scene/build.ts; the coordinator can fold
 * both copies into build.ts.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { BunPlugin } from 'bun'
import { REPO_DIR } from '../../../build'

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
        const source = readFileSync(args.path, 'utf8').replace(
          GLOB_CALL,
          (_call, pattern: string) => {
            const prefix = Object.keys(GLOB_ROOTS).find((key) => pattern.startsWith(key))
            const absolute = prefix ? GLOB_ROOTS[prefix] + pattern.slice(prefix.length) : pattern
            const dir = path.dirname(absolute)
            const entries = [...new Bun.Glob(path.basename(absolute)).scanSync({ cwd: dir })].map(
              (name) => {
                const file = path.join(dir, name)
                return `${JSON.stringify(`/${path.relative(REPO_DIR, file)}`)}: ${JSON.stringify(readFileSync(file, 'utf8'))}`
              }
            )
            return `({${entries.join(',')}})`
          }
        )
        return { loader: 'ts', contents: source }
      })
    }
  }
}
