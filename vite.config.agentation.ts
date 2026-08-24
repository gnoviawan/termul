/**
 * Vite config for bundling agentation's React toolbar into a self-contained
 * IIFE for injection into child webviews (issue #451, Epic 2).
 *
 * Output: src-tauri/resources/agentation-toolbar.js (~375KB IIFE)
 *
 * Bundles React 18 + ReactDOM + the PageFeedbackToolbarCSS component
 * into a single file that runs in any browser context (no module loader needed).
 * Shadow DOM isolation prevents the host page's CSS from leaking into the toolbar.
 */
import path from 'node:path'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      agentation: path.resolve(__dirname, '../../agentation/package/src/index.ts')
    }
  },

  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    __VERSION__: JSON.stringify('3.0.2')
  },

  // Handle CJS React/ReactDOM properly for IIFE bundling
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']
  },

  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/agentation-toolbar/entry.tsx'),
      name: 'AgentationToolbar',
      fileName: () => 'agentation-toolbar.js',
      format: 'iife'
    },
    outDir: 'src-tauri/resources',
    emptyOutDir: false,
    assetsInlineLimit: 100000000,
    sourcemap: false,
    minify: 'esbuild',
    target: 'esnext',
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      },
      external: []
    },
    // Tell rolldown to handle CJS named exports from React
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/]
    }
  }
})
