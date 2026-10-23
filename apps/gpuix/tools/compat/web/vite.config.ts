import path from 'node:path'
import { mergeConfig } from 'vite'
import base from '../../../../../vite.config.web'

export const WEB_FIXTURE_OUT = '/tmp/gpuix-c1/web-dist'

const config = mergeConfig(base, {
  root: __dirname,
  publicDir: false,
  css: { postcss: path.resolve(__dirname, '../../../../..') },
  // apps/gpuix/node_modules holds React 19 for GPUIX; the reference uses the app's React.
  resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
  build: { outDir: WEB_FIXTURE_OUT, emptyOutDir: true, sourcemap: false }
})
config.build.rolldownOptions = { input: path.join(__dirname, 'index.html') }
export default config
