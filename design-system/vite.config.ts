import path from 'node:path'
import { defineConfig, mergeConfig } from 'vite'
import webConfig from '../vite.config.web'

/**
 * Design-system canvas build. Reuses the web client config (aliases, Tauri
 * stubs, defines) so previews import production modules exactly as the web
 * client does. Only the entry, root and output change.
 */
export default mergeConfig(
  webConfig,
  defineConfig({
    root: __dirname,
    base: './',
    publicDir: false,
    server: { port: 5199 },
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      rolldownOptions: {
        input: path.resolve(__dirname, 'index.html')
      }
    }
  })
)
