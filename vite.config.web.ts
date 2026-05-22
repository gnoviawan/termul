import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

const tauriMocksDir = path.resolve(__dirname, './src/renderer/lib/tauri-mocks')

export default defineConfig(({ mode }) => ({
  server: {
    host: '::',
    port: 5173,
  },
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src/renderer') },
      { find: '@shared', replacement: path.resolve(__dirname, './src/shared') },
      // Mock all @tauri-apps/* so web builds don't crash at import time
      { find: '@tauri-apps/api/event', replacement: path.join(tauriMocksDir, 'api-event.ts') },
      { find: '@tauri-apps/api/core', replacement: path.join(tauriMocksDir, 'api-core.ts') },
      { find: '@tauri-apps/api/window', replacement: path.join(tauriMocksDir, 'api-window.ts') },
      { find: /^@tauri-apps\/plugin-(.+)$/, replacement: path.join(tauriMocksDir, 'plugin-noop.ts') },
      { find: /^@tauri-apps\/api\/(.+)$/, replacement: path.join(tauriMocksDir, 'api-noop.ts') },
    ],
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, './web-index.html'),
    },
  },
  define: {
    'import.meta.env.VITE_WS_URL': JSON.stringify(process.env.VITE_WS_URL || 'ws://localhost:9876'),
    'import.meta.env.VITE_WS_TOKEN': JSON.stringify(process.env.VITE_WS_TOKEN || ''),
  },
}))
