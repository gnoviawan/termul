import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

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
      '@shared': resolve('src/shared')
    }
  }
})
