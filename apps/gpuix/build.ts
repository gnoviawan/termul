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

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { BunPlugin } from 'bun'
import { gpuixUiAliases } from './tools/ui/alias'

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

const COMPAT_DIR = path.join(APP_DIR, 'src/compat')

/** DOM-bound packages -> compat stand-ins with the same exports. */
export const PACKAGE_ALIASES: Record<string, string> = {
  'react-dom': 'react-dom.ts',
  'react-dom/client': 'react-dom.ts',
  '@radix-ui/react-slot': 'radix/slot.tsx',
  '@radix-ui/react-tooltip': 'radix/tooltip.tsx',
  '@radix-ui/react-popover': 'radix/popover.tsx',
  '@radix-ui/react-dropdown-menu': 'radix/dropdown-menu.tsx',
  '@radix-ui/react-context-menu': 'radix/context-menu.tsx',
  '@radix-ui/react-dialog': 'radix/dialog.tsx',
  '@radix-ui/react-alert-dialog': 'radix/dialog.tsx',
  '@radix-ui/react-scroll-area': 'radix/simple.tsx',
  '@radix-ui/react-separator': 'radix/simple.tsx',
  '@radix-ui/react-label': 'radix/simple.tsx',
  '@radix-ui/react-collapsible': 'radix/simple.tsx',
  '@radix-ui/react-accordion': 'radix/generic.tsx',
  '@radix-ui/react-hover-card': 'radix/generic.tsx',
  '@radix-ui/react-switch': 'radix/generic.tsx',
  '@radix-ui/react-select': 'radix/generic.tsx',
  'framer-motion': 'shims/framer-motion.tsx',
  cmdk: 'shims/cmdk.tsx',
  '@streamdown/mermaid': 'shims/streamdown-mermaid.ts'
}

/**
 * Files written against GPUIX directly keep the real JSX runtime and React:
 * everything under apps/gpuix except the compat stand-ins (radix, shims),
 * which are DOM components like the code they replace.
 */
const DOM_DIRS = ['src/compat/radix', 'src/compat/shims', 'tools/compat/fixtures/dom', 'tools/compat/bench/dom'].map(
  (dir) => path.join(APP_DIR, dir) + path.sep
)

export function isNativeImporter(importer: string): boolean {
  if (!importer.startsWith(APP_DIR + path.sep)) return false
  return !DOM_DIRS.some((dir) => importer.startsWith(dir))
}

export const OVERRIDES_DIR = path.join(APP_DIR, 'src/overrides')

/**
 * A native override of a shared file lives at `src/overrides/<path relative to
 * src/renderer>` and exports the same names; it replaces the shared file for
 * every importer except itself.
 */
export function overrideFor(resolved: string, importer: string): string | null {
  if (!resolved.startsWith(RENDERER_DIR + path.sep)) return null
  const rel = path.relative(RENDERER_DIR, resolved).replace(/\.(tsx?|jsx?)$/, '')
  for (const ext of ['.tsx', '.ts']) {
    const candidate = path.join(OVERRIDES_DIR, rel + ext)
    if (candidate !== importer && existsSync(candidate)) return candidate
  }
  return null
}

export interface CompatResolve {
  specifier: string
  target: string
}

/** Strategy B: shared DOM components compile against the compat runtime. */
export function compatPlugin(aliases?: CompatResolve[]): BunPlugin {
  return {
    name: 'termul-gpuix-compat',
    setup(build) {
      build.onResolve({ filter: /^(react|@gpuix\/react)\/jsx(-dev)?-runtime$/ }, (args) => {
        if (isNativeImporter(args.importer)) return { path: args.path, external: true }
        return { path: path.join(COMPAT_DIR, 'jsx-runtime.ts') }
      })
      build.onResolve({ filter: /^react$/ }, (args) => {
        if (isNativeImporter(args.importer)) return { path: 'react', external: true }
        return { path: path.join(COMPAT_DIR, 'react.ts') }
      })
      build.onResolve({ filter: /^(react-dom(\/client)?|@radix-ui\/.*|framer-motion|cmdk|@streamdown\/mermaid)$/ }, (args) => {
        if (args.path.startsWith('react-dom') && isNativeImporter(args.importer)) {
          return { path: args.path, external: true }
        }
        const target = PACKAGE_ALIASES[args.path]
        if (!target) throw new Error(`compat: no stand-in for ${args.path} (imported by ${args.importer})`)
        aliases?.push({ specifier: args.path, target })
        return { path: path.join(COMPAT_DIR, target) }
      })
    }
  }
}

/** Swap shared files for `src/overrides/**` twins, for `@/` and relative imports alike. */
export function overridesPlugin(): BunPlugin {
  return {
    name: 'termul-gpuix-overrides',
    setup(build) {
      build.onResolve({ filter: /^(@\/|@renderer\/)/ }, (args) => {
        const resolved = Bun.resolveSync(`./${args.path.replace(/^@(renderer)?\//, '')}`, RENDERER_DIR)
        return { path: overrideFor(resolved, args.importer) ?? resolved }
      })
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (!args.importer.startsWith(RENDERER_DIR + path.sep)) return undefined
        const resolved = Bun.resolveSync(args.path, path.dirname(args.importer))
        const override = overrideFor(resolved, args.importer)
        return override ? { path: override } : undefined
      })
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

export async function buildClient(
  entry: string = ENTRY,
  outdir: string = OUT_DIR,
  options: { production?: boolean } = {}
): Promise<BuildResult> {
  const reactResolves: ReactResolve[] = []
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: 'bun',
    format: 'esm',
    sourcemap: 'linked',
    // react and react-dom are not listed: the plugins decide per importer.
    external: ['@gpuix/react', '@gpuix/react/*', '@gpuix/native', '@gpuix/native/*'],
    plugins: [compatPlugin(), gpuixUiAliases(), overridesPlugin(), termulResolver(reactResolves)],
    naming: '[name].[ext]',
    // React's production build has no jsxDEV, so a production bundle needs jsx().
    ...(options.production
      ? { jsx: { development: false }, define: { 'process.env.NODE_ENV': '"production"' } }
      : {})
  })
  return {
    ok: result.success,
    entry: path.join(outdir, `${path.basename(entry).replace(/\.tsx?$/, '')}.js`),
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
