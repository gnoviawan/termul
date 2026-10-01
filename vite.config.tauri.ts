import { createRequire } from 'node:module'
import path from 'node:path'
import react from '@vitejs/plugin-react-swc'
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

const host = process.env.TAURI_DEV_HOST
// Dev server port. Override with TAURI_DEV_PORT (must match devUrl in
// src-tauri/tauri.conf.json, or pass a matching --config override to tauri).
// Validate the env value: must be an integer in the valid TCP port range,
// else fall back to the default and warn.
function resolveDevPort(): number {
  const fallback = 5180
  const raw = process.env.TAURI_DEV_PORT
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    console.warn(`[vite] Invalid TAURI_DEV_PORT="${raw}"; falling back to ${fallback}.`)
    return fallback
  }
  return parsed
}
const devPort = resolveDevPort()
// Keep the HMR port within range even at the boundary.
const hmrPort = devPort < 65535 ? devPort + 1 : devPort - 1

// Perf toolkit (tools/perf): opt-in release-grade React commit timing.
// react-dom/profiling carries the DevTools hook timings; it is a perf-only
// build flavor and NEVER ships. Zero behavior change when the env is unset.
const perfProfiling = process.env.TERMUL_PERF_PROFILING === '1'

export default defineConfig({
  root: './',
  base: '/',

  plugins: [react()],

  resolve: {
    alias: {
      '@/': `${path.resolve(__dirname, 'src/renderer')}/`,
      '@renderer/': `${path.resolve(__dirname, 'src/renderer')}/`,
      '@shared/': `${path.resolve(__dirname, 'src/shared')}/`,
      '@material-icons/': `${materialIconsDir}/`,
      // Perf-only remap: import 'react-dom' resolves to the profiling build
      // when TERMUL_PERF_PROFILING=1 (the tools/perf runner sets it for
      // measurement builds). Unset → identical resolution to before.
      ...(perfProfiling ? { 'react-dom': 'react-dom/profiling' } : {})
    }
  },

  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(pkg.version)
  },

  // Vite dev server config for Tauri
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: hmrPort
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },

  build: {
    outDir: 'dist-tauri',
    emptyOutDir: true,
    rolldownOptions: {
      input: path.resolve(__dirname, 'tauri-index.html')
    },
    target: 'esnext'
  },

  // Env prefix for Tauri
  envPrefix: ['VITE_', 'TAURI_ENV_*']
})
