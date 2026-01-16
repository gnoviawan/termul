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
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@renderer/*': resolve(__dirname, 'src/renderer/*'),
      '@/*': resolve(__dirname, 'src/renderer/*'),
      '@/types': resolve(__dirname, 'src/renderer/types'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@shared/*': resolve(__dirname, 'src/shared/*')
    }
  }
})
