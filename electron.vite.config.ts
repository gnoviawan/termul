import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react-swc'
import pkg from './package.json' assert { type: 'json' }

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
    plugins: [react()],
    define: {
      'import.meta.env.PACKAGE_VERSION': JSON.stringify(pkg.version)
    }
  }
})
