import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const materialIconsDir = join(dirname(require.resolve('material-icon-theme/package.json')), 'icons')

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    typecheck: {
      tsconfig: 'tsconfig.web.json'
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
