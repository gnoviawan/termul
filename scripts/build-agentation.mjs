/**
 * Build script for the agentation toolbar IIFE bundle.
 *
 * Uses esbuild directly (instead of Vite) because Vite 8's rolldown bundler
 * has CJS/ESM interop issues with React for IIFE format. esbuild handles
 * CJS React named exports correctly.
 *
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { compile } from 'sass-embedded'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

// SCSS loader for esbuild — compiles .scss and .module.scss files
function scssLoader() {
  return {
    name: 'scss',
    setup(build) {
      // Regular SCSS files
      build.onLoad({ filter: /\.scss$/ }, async (args) => {
        const isModule = args.path.includes('.module.')
        const result = compile(args.path)
        const css = result.css

        const parentDir = path.basename(path.dirname(args.path))
        const baseName = path.basename(args.path, isModule ? '.module.scss' : '.scss')
        const styleId = `${parentDir}-${baseName}`

        if (isModule) {
          // CSS Module — generate scoped class names and inject as JS
          // Simple approach: use the styleId as prefix for all class names
          const scopedCss = css.replace(/\.([a-zA-Z_][\w-]*)/g, `.${styleId}_$1`)
          const cssModuleJs = `
            const styles = {};
            const css = ${JSON.stringify(scopedCss)};
            if (typeof document !== 'undefined') {
              const style = document.createElement('style');
              style.textContent = css;
              document.head.appendChild(style);
              css.replace(/\\.([a-zA-Z_][\\w-]*)/g, (m, cls) => { styles[cls] = cls; return ''; });
            }
            export default styles;
          `
          return {
            contents: cssModuleJs,
            loader: 'js'
          }
        }
        // Non-module SCSS — inject as global CSS
        return {
          contents: `
            if (typeof document !== 'undefined') {
              const style = document.createElement('style');
              style.textContent = ${JSON.stringify(css)};
              document.head.appendChild(style);
            }
          `,
          loader: 'js'
        }
      })
    }
  }
}

// Empty loader for assets we don't need
const emptyLoader = {
  name: 'empty',
  setup(build) {
    build.onLoad({ filter: /\.(png|svg|jpg|jpeg|gif|woff2?|ttf|eot)$/ }, () => ({
      contents: 'export default ""',
      loader: 'js'
    }))
  }
}

const entryPoint = path.resolve(projectRoot, 'src/agentation-toolbar/entry.tsx')
const outfile = path.resolve(projectRoot, 'src-tauri/resources/agentation-toolbar.js')

try {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'iife',
    globalName: 'AgentationToolbar',
    jsx: 'automatic',
    minify: true,
    outfile,
    sourcemap: false,
    target: 'esnext',
    define: {
      'process.env.NODE_ENV': '"production"',
      __VERSION__: '"3.0.2"'
    },
    loader: {
      '.tsx': 'tsx',
      '.ts': 'ts'
    },
    plugins: [scssLoader(), emptyLoader],
    logLevel: 'info'
  })

  const stats = fs.statSync(outfile)
  const sizeKB = Math.round(stats.size / 1024)
  console.log(`✓ Agentation toolbar built: ${outfile} (${sizeKB}KB)`)

  if (sizeKB > 600) {
    console.error(`✗ Bundle size ${sizeKB}KB exceeds 600KB limit`)
    process.exit(1)
  }
} catch (error) {
  console.error('✗ Build failed:', error)
  process.exit(1)
}
