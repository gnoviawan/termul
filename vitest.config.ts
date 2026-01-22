import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    typecheck: {
      tsconfig: 'tsconfig.web.json'
    },
    resolveSnapshotPath: (snapshotPath, testPath) => {
      // Keep snapshots in __snapshots__ directory next to test files
      return snapshotPath
    },
    // ESM-specific configuration for mocking (Vitest 4.x API)
    singleThread: true,
    // Ensure proper module resolution for mocks
    server: {
      deps: {
        // Inline electron and micromatch to force Vitest to process them
        inline: ['electron', 'micromatch', '@electron-toolkit/utils', '@electron-toolkit/preload', 'electron-updater']
      },
      // Force Vitest to not externalize electron
      fs: {
        strict: false
      }
    },
    // Use vmThreads pool for better ESM mocking support
    pool: 'threads',
    // Use fake timers to avoid issues with timers
    useAtomics: true
  },
  resolve: {
    alias: {
      // Redirect electron imports to a mock file (will be created)
      electron: resolve(__dirname, 'vitest-mocks/electron.ts'),
      micromatch: resolve(__dirname, 'vitest-mocks/micromatch.ts'),
      '@': resolve(__dirname, 'src/renderer'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@renderer/*': resolve(__dirname, 'src/renderer/*'),
      '@/*': resolve(__dirname, 'src/renderer/*'),
      '@/types': resolve(__dirname, 'src/renderer/types'),
      '@/lib': resolve(__dirname, 'src/renderer/lib'),
      '@/components': resolve(__dirname, 'src/renderer/components'),
      '@/stores': resolve(__dirname, 'src/renderer/stores'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@shared/*': resolve(__dirname, 'src/shared/*')
    }
  }
})
