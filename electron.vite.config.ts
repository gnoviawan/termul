import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react-swc'

// Force legacy ESM shim (fileURLToPath) for better asar archive compatibility
process.env.ELECTRON_MAJOR_VER = '29'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@': resolve('src/renderer')
      }
    },
    plugins: [react()]
  }
})
