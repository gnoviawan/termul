/**
 * Build both sides of the ui gallery from the one Gallery.tsx:
 * - GPUIX: Bun.build with the ui aliases ahead of the Termul resolver.
 * - Web: Vite with Termul's index.css (Tailwind via PostCSS) and the root's React 18.
 */
import path from 'node:path'
import { APP_DIR, EXTERNAL, REPO_DIR, termulResolver } from '../../../build'
import { gpuixUiAliases } from '../alias'

const GALLERY_DIR = import.meta.dir

export async function buildGpuixGallery(outDir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(GALLERY_DIR, 'gpuix-entry.tsx')],
    outdir: outDir,
    target: 'bun',
    format: 'esm',
    external: EXTERNAL.flatMap((name) => [name, `${name}/*`]),
    plugins: [gpuixUiAliases(), termulResolver()],
    naming: '[name].[ext]'
  })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  return path.join(outDir, 'gpuix-entry.js')
}

export async function buildWebGallery(outDir: string): Promise<string> {
  const vite = await import(path.join(REPO_DIR, 'node_modules/vite/dist/node/index.js'))
  const react = (
    await import(path.join(REPO_DIR, 'node_modules/@vitejs/plugin-react-swc/index.js'))
  ).default
  const tailwind = (
    await import(path.join(REPO_DIR, 'node_modules/@tailwindcss/postcss/dist/index.mjs'))
  ).default
  const renderer = path.join(REPO_DIR, 'src/renderer')
  const modules = path.join(REPO_DIR, 'node_modules')
  // vite.build sets NODE_ENV=production for the process; a GPUIX app launched
  // afterwards with that env does not answer the automation handshake.
  const nodeEnv = process.env.NODE_ENV
  await vite.build({
    configFile: false,
    logLevel: 'warn',
    root: path.join(GALLERY_DIR, 'web'),
    base: './',
    plugins: [react()],
    css: { postcss: { plugins: [tailwind({ base: REPO_DIR })] } },
    resolve: {
      alias: [
        { find: /^react(\/.*)?$/, replacement: `${modules}/react$1` },
        { find: /^react-dom(\/.*)?$/, replacement: `${modules}/react-dom$1` },
        { find: /^@\//, replacement: `${renderer}/` },
        { find: /^@shared\//, replacement: `${path.join(REPO_DIR, 'src/shared')}/` }
      ]
    },
    define: {
      'import.meta.env.TERMUL_WEB': 'true',
      'import.meta.env.PACKAGE_VERSION': '"0.0.0"',
      'import.meta.env.VITE_APP_VERSION': '"0.0.0"'
    },
    build: { outDir, emptyOutDir: true }
  })
  if (nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = nodeEnv
  return outDir
}

if (import.meta.main) {
  const out = process.argv[2] ?? '/tmp/gpuix-k1/gallery'
  console.log(await buildGpuixGallery(path.join(APP_DIR, 'dist/gallery')))
  console.log(await buildWebGallery(path.join(out, 'web-dist')))
}
