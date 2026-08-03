import { createRequire } from 'node:module'
import path from 'node:path'
import react from '@vitejs/plugin-react-swc'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

// Resolve the material-icon-theme icons directory via Node module resolution
// instead of a hardcoded node_modules path, so it works under hoisted,
// monorepo, or custom-resolve setups.
const require = createRequire(import.meta.url)
const materialIconsDir = path.join(
  path.dirname(require.resolve('material-icon-theme/package.json')),
  'icons'
)

const stub = (name: string) => path.resolve(__dirname, `src/renderer/lib/tauri-stubs/${name}.ts`)

/** Explicit `@tauri-apps/*` → stub map for the App import graph (Story 1.5 AC3). */
const TAURI_STUB_ALIASES: Record<string, string> = {
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

/**
 * Fail the web build loudly if a new `@tauri-apps/*` specifier is not aliased.
 * Known aliases are left to `resolve.alias`; unknowns become a virtual throw module.
 */
function tauriStubFallback(): Plugin {
  return {
    name: 'tauri-web-stub-fallback',
    enforce: 'pre',
    resolveId(id) {
      if (!id.startsWith('@tauri-apps/')) return null
      if (id in TAURI_STUB_ALIASES) return null
      return `\0tauri-unstubbed:${id}`
    },
    load(id) {
      if (!id.startsWith('\0tauri-unstubbed:')) return null
      const pkg = id.slice('\0tauri-unstubbed:'.length)
      return `throw new Error(${JSON.stringify(
        `Web build: unhandled @tauri-apps import "${pkg}". Add a stub alias in vite.config.web.ts.`
      )})`
    }
  }
}

/**
 * Browser / headless-server web client build (Story 1.2 / 1.5).
 *
 * Mirrors `vite.config.tauri.ts` plugin/alias/define setup but targets
 * `index.html` → `dist-web/` and sets `import.meta.env.TERMUL_WEB`.
 *
 * Story 1.5: alias every `@tauri-apps/*` specifier used by the App import graph
 * to thin browser stubs so Rollup never embeds real Tauri package code.
 * Desktop builds (`vite.config.tauri.ts`) are NOT aliased.
 */
export default defineConfig({
  root: './',
  base: '/',

  plugins: [react(), tauriStubFallback()],

  resolve: {
    alias: {
      '@/': `${path.resolve(__dirname, 'src/renderer')}/`,
      '@renderer/': `${path.resolve(__dirname, 'src/renderer')}/`,
      '@shared/': `${path.resolve(__dirname, 'src/shared')}/`,
      '@material-icons/': `${materialIconsDir}/`,
      // Web-only Tauri stubs (Story 1.5 AC3) — keep package subpaths explicit.
      ...TAURI_STUB_ALIASES
    }
  },

  optimizeDeps: {
    // Avoid prebundling real Tauri packages into the web dep graph.
    exclude: [
      '@tauri-apps/api',
      '@tauri-apps/plugin-clipboard-manager',
      '@tauri-apps/plugin-os',
      '@tauri-apps/plugin-dialog',
      '@tauri-apps/plugin-opener',
      '@tauri-apps/plugin-fs',
      '@tauri-apps/plugin-store',
      '@tauri-apps/plugin-notification',
      '@tauri-apps/plugin-process',
      '@tauri-apps/plugin-updater'
    ]
  },

  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(pkg.version),
    // Feature-gate signal for Story 1.5+ (desktop-only path exclusion).
    'import.meta.env.TERMUL_WEB': JSON.stringify(true),
    // CAP-3: build-time app version for `getCurrentAppVersion()` web branch
    // (tauri-release-notes.ts). Desktop reads version via Tauri `getVersion`;
    // the web client has no Tauri runtime, so inject the package version as a
    // string literal here. Tests run under Vitest (not this config) and read
    // `undefined`, which the facade downgrades to `'0.0.0'`.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version)
  },

  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rolldownOptions: {
      input: path.resolve(__dirname, 'index.html')
    },
    target: 'esnext'
  }
})
