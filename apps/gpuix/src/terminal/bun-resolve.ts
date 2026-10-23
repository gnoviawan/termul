/**
 * Bun preload plugin: resolves the renderer's `@/`, `@shared/` and
 * `@tauri-apps/*` specifiers for files imported from `src/renderer`, whose
 * nearest tsconfig (the repo root) maps only `@/`. Mirrors the alias map of
 * `vite.config.web.ts`. Registered through `apps/gpuix/bunfig.toml`.
 */
import { plugin } from 'bun'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')
const renderer = resolve(root, 'src/renderer')
const shared = resolve(root, 'src/shared')
const stubs = resolve(renderer, 'lib/tauri-stubs')

const TAURI_STUBS: Record<string, string> = {
  '@tauri-apps/api/core': 'api-core',
  '@tauri-apps/api/event': 'api-event',
  '@tauri-apps/api/window': 'api-window',
  '@tauri-apps/api/webview': 'api-webview',
  '@tauri-apps/api/path': 'api-path',
  '@tauri-apps/api/app': 'api-app',
  '@tauri-apps/plugin-clipboard-manager': 'plugin-clipboard-manager',
  '@tauri-apps/plugin-os': 'plugin-os',
  '@tauri-apps/plugin-dialog': 'plugin-dialog',
  '@tauri-apps/plugin-opener': 'plugin-opener',
  '@tauri-apps/plugin-fs': 'plugin-fs',
  '@tauri-apps/plugin-store': 'plugin-store',
  '@tauri-apps/plugin-notification': 'plugin-notification',
  '@tauri-apps/plugin-process': 'plugin-process',
  '@tauri-apps/plugin-updater': 'plugin-updater'
}

const withExtension = (base: string): string => {
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = `${base}${ext}`
    if (Bun.file(candidate).size > 0) return candidate
  }
  return `${base}.ts`
}

plugin({
  name: 'termul-renderer-aliases',
  setup(build) {
    build.onResolve({ filter: /^@\// }, ({ path }) => ({
      path: withExtension(resolve(renderer, path.slice(2)))
    }))
    build.onResolve({ filter: /^@shared\// }, ({ path }) => ({
      path: withExtension(resolve(shared, path.slice('@shared/'.length)))
    }))
    build.onResolve({ filter: /^@tauri-apps\// }, ({ path }) => {
      const stub = TAURI_STUBS[path]
      if (!stub) throw new Error(`GPUIX: unhandled @tauri-apps import "${path}"; add it to bun-resolve.ts`)
      return { path: resolve(stubs, `${stub}.ts`) }
    })
  }
})
