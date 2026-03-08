import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'
import pkg from './package.json' with { type: 'json' }

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  root: './',
  base: '/',

  plugins: [react()],

  resolve: {
    alias: {
      '@/': `${path.resolve(__dirname, 'src/renderer')}/`,
      '@renderer/': `${path.resolve(__dirname, 'src/renderer')}/`,
      '@shared/': `${path.resolve(__dirname, 'src/shared')}/`
    }
  },

  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(pkg.version)
  },

  // Vite dev server config for Tauri
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 5174
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },

  build: {
    outDir: 'dist-tauri',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'tauri-index.html')
    },
    target: 'esnext',
    minify: 'esbuild'
  },

  // Env prefix for Tauri
  envPrefix: ['VITE_', 'TAURI_ENV_*']
})
