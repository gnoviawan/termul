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

/**
 * Browser / headless-server web client build (Story 1.2).
 *
 * Mirrors `vite.config.tauri.ts` plugin/alias/define setup but targets
 * `index.html` → `dist-web/` and sets `import.meta.env.TERMUL_WEB` so later
 * stories (1.5+) can feature-gate desktop-only code paths. No Tauri
 * server/envPrefix/HMR config.
 */
export default defineConfig({
  root: './',
  base: '/',

  plugins: [react()],

  resolve: {
    alias: {
      '@/': `${path.resolve(__dirname, 'src/renderer')}/`,
      '@renderer/': `${path.resolve(__dirname, 'src/renderer')}/`,
      '@shared/': `${path.resolve(__dirname, 'src/shared')}/`,
      '@material-icons/': `${materialIconsDir}/`
    }
  },

  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(pkg.version),
    // Feature-gate signal for Story 1.5+ (desktop-only path exclusion).
    'import.meta.env.TERMUL_WEB': JSON.stringify(true)
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
