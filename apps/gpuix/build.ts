/**
 * Bundle the GPUIX client with `Bun.build`.
 *
 * Shared files under `src/renderer` import `react`, `@/…`, `@shared/…`,
 * `sonner` and `@tauri-apps/*`. Bun's runtime would resolve `react` to the
 * repo root's React 18 and the Tauri packages to the real ones, and a runtime
 * `onResolve` plugin never sees static ESM imports (measured on Bun 1.4.0), so
 * the aliasing happens here, at bundle time:
 *
 * - `@/`, `@renderer/`, `@shared/` and `@tauri-apps/*` mirror `vite.config.web.ts`.
 * - `sonner` becomes `src/shims/sonner.ts` (the real one renders DOM).
 * - `react` and `react-dom` stay external, so the bundle, `@gpuix/react` and
 *   every vendored library load the single copy in `apps/gpuix/node_modules`.
 * - `@gpuix/*` stays external: the native addon is loaded by file path.
 *
 * Run `bun build.ts` for one build, or `bun tools/dev.ts` to rebuild on change.
 */

import path from 'node:path'
import type { BunPlugin } from 'bun'

export const APP_DIR = import.meta.dir
export const REPO_DIR = path.resolve(APP_DIR, '../..')
export const OUT_DIR = path.join(APP_DIR, 'dist')
export const ENTRY = path.join(APP_DIR, 'src/main.tsx')

const RENDERER_DIR = path.join(REPO_DIR, 'src/renderer')
const SHARED_DIR = path.join(REPO_DIR, 'src/shared')
const STUBS_DIR = path.join(RENDERER_DIR, 'lib/tauri-stubs')

const stub = (name: string): string => path.join(STUBS_DIR, `${name}.ts`)

/** Explicit `@tauri-apps/*` → stub map, the same set as `vite.config.web.ts`. */
export const TAURI_STUB_ALIASES: Record<string, string> = {
  '@tauri-apps/api/core': stub('api-core'),
  '@tauri-apps/api/event': stub('api-event'),
  '@tauri-apps/api/window': stub('api-window'),
  '@tauri-apps/api/webview': stub('api-webview'),
  '@tauri-apps/api/path': stub('api-path'),
  '@tauri-apps/api/app': stub('api-app'),
  '@tauri-apps/plugin-clipboard-manager': stub('plugin-clipboard-manager'),
  '@tauri-apps/plugin-os': stub('plugin-os'),
  '@tauri-apps/plugin-dialog': stub('plugin-dialog'),
  '@tauri-apps/plugin-opener': stub('plugin-opener'),
  '@tauri-apps/plugin-fs': stub('plugin-fs'),
  '@tauri-apps/plugin-store': stub('plugin-store'),
  '@tauri-apps/plugin-notification': stub('plugin-notification'),
  '@tauri-apps/plugin-process': stub('plugin-process'),
  '@tauri-apps/plugin-updater': stub('plugin-updater')
}

/** Packages kept out of the bundle and loaded from `apps/gpuix/node_modules`. */
export const EXTERNAL = ['react', 'react-dom', '@gpuix/react', '@gpuix/native']

export interface ReactResolve {
  specifier: string
  importer: string
}

const UNSTUBBED = 'tauri-unstubbed'

/** The alias plugin. `reactResolves`, when given, receives every `react`/`react-dom` import. */
export function termulResolver(reactResolves?: ReactResolve[]): BunPlugin {
  return {
    name: 'termul-gpuix-resolver',
    setup(build) {
      build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
        reactResolves?.push({ specifier: args.path, importer: args.importer })
        return { path: args.path, external: true }
      })
      build.onResolve({ filter: /^@\// }, (args) => ({
        path: Bun.resolveSync(`./${args.path.slice('@/'.length)}`, RENDERER_DIR)
      }))
      build.onResolve({ filter: /^@renderer\// }, (args) => ({
        path: Bun.resolveSync(`./${args.path.slice('@renderer/'.length)}`, RENDERER_DIR)
      }))
      build.onResolve({ filter: /^@shared\// }, (args) => ({
        path: Bun.resolveSync(`./${args.path.slice('@shared/'.length)}`, SHARED_DIR)
      }))
      build.onResolve({ filter: /^sonner$/ }, () => ({
        path: path.join(APP_DIR, 'src/shims/sonner.ts')
      }))
      build.onResolve({ filter: /^@tauri-apps\// }, (args) => {
        const target = TAURI_STUB_ALIASES[args.path]
        if (target) return { path: target }
        return { path: args.path, namespace: UNSTUBBED }
      })
      build.onLoad({ filter: /.*/, namespace: UNSTUBBED }, (args) => ({
        loader: 'js',
        contents: `throw new Error(${JSON.stringify(
          `GPUIX client: unhandled @tauri-apps import "${args.path}". Add a stub alias in apps/gpuix/build.ts.`
        )})`
      }))
    }
  }
}

export interface BuildResult {
  ok: boolean
  /** Absolute path of the entry bundle. */
  entry: string
  reactResolves: ReactResolve[]
  logs: string[]
}

export async function buildClient(): Promise<BuildResult> {
  const reactResolves: ReactResolve[] = []
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUT_DIR,
    target: 'bun',
    format: 'esm',
    sourcemap: 'linked',
    external: EXTERNAL.flatMap((name) => [name, `${name}/*`]),
    plugins: [termulResolver(reactResolves)],
    naming: '[name].[ext]'
  })
  return {
    ok: result.success,
    entry: path.join(OUT_DIR, 'main.js'),
    reactResolves,
    logs: result.logs.map((log) => String(log))
  }
}

if (import.meta.main) {
  const started = performance.now()
  const result = await buildClient()
  for (const line of result.logs) console.error(line)
  if (!result.ok) process.exit(1)
  console.log(
    `built ${path.relative(APP_DIR, result.entry)} in ${Math.round(performance.now() - started)} ms`
  )
}
