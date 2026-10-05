import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const materialIconsDir = join(dirname(require.resolve('material-icon-theme/package.json')), 'icons')

// Worktrees symlink node_modules at another checkout. Vite resolves that
// symlink and then refuses `?raw` SVG imports that land outside this root.
const nodeModulesReal = realpathSync(resolve('node_modules'))

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [resolve('.'), nodeModulesReal]
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    // CI runners (GitHub Actions) are slower than local dev, and the full
    // suite (3800+ tests) adds event-loop/import contention that can push
    // multi-step async tests (waitFor + act chains) past vitest's 5s default.
    // 15s gives headroom without masking real hangs.
    testTimeout: 15000,
    typecheck: {
      tsconfig: 'tsconfig.test.json'
    }
  },
  resolve: {
    alias: {
      '@': resolve('src/renderer'),
      '@renderer': resolve('src/renderer'),
      '@/types': resolve('src/renderer/types'),
      '@shared': resolve('src/shared'),
      '@material-icons/': `${materialIconsDir}/`
    }
  }
})
