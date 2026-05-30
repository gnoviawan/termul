import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'
import pkg from './package.json' with { type: 'json' }

const host = process.env.TAURI_DEV_HOST
// Dev server port. Override with TAURI_DEV_PORT (must match devUrl in
// src-tauri/tauri.conf.json, or pass a matching --config override to tauri).
const devPort = Number(process.env.TAURI_DEV_PORT) || 5180
const hmrPort = devPort + 1

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
