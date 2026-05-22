import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig(({ mode }) => ({
  server: {
    host: '::',
    port: 5173,
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
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
