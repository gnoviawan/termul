/**
 * Prove the shared renderer code and the GPUIX app share one React.
 *
 * `bun tools/check-react.ts` bundles the client and checks three things:
 * 1. every `react` / `react-dom` import the bundler saw, from `src/renderer`
 *    and from vendored packages alike, was left external (the table lists
 *    the importers);
 * 2. the bundle contains no inlined React copy;
 * 3. resolved from the bundle's directory, `react` is the 19.x copy in
 *    `apps/gpuix/node_modules`, the same file `@gpuix/react` resolves to.
 */

import path from 'node:path'
import { APP_DIR, buildClient } from '../build'

const result = await buildClient()
for (const line of result.logs) console.error(line)
if (!result.ok) process.exit(1)

let failed = false
const fail = (message: string): void => {
  failed = true
  console.log(`BAD  ${message}`)
}

const fromRenderer = result.reactResolves.filter((entry) =>
  entry.importer.includes('/src/renderer/')
)
const fromVendor = result.reactResolves.filter((entry) => entry.importer.includes('/node_modules/'))
const fromApp = result.reactResolves.filter((entry) =>
  entry.importer.startsWith(path.join(APP_DIR, 'src'))
)
console.log(
  `react imports left external: ${result.reactResolves.length} (src/renderer ${fromRenderer.length}, node_modules ${fromVendor.length}, apps/gpuix ${fromApp.length})`
)
const vendorPackages = new Set(
  fromVendor.map((entry) => entry.importer.split('/node_modules/').pop()?.split('/')[0] ?? '?')
)
console.log(`      vendored importers: ${[...vendorPackages].sort().join(', ')}`)
console.log(
  `      renderer importers: ${[
    ...new Set(fromRenderer.map((entry) => path.relative(APP_DIR, entry.importer)))
  ]
    .sort()
    .slice(0, 8)
    .join(', ')}`
)

const bundle = await Bun.file(result.entry).text()
const inlinedMarkers = [
  'react.development.js',
  'react.production.js',
  '__CLIENT_INTERNALS_DO_NOT_USE',
  '__SECRET_INTERNALS_DO_NOT_USE'
]
for (const marker of inlinedMarkers) {
  if (bundle.includes(marker)) fail(`bundle contains an inlined React (${marker})`)
}
const externalImports = [...bundle.matchAll(/from\s*"(react(?:-dom)?(?:\/[^"]*)?)"/g)].map(
  (match) => match[1]
)
console.log(
  `bundle imports react through ${new Set(externalImports).size} external specifier(s): ${[...new Set(externalImports)].join(', ')}`
)
if (!externalImports.includes('react')) fail('bundle has no external `react` import')

const fromBundle = Bun.resolveSync('react', path.dirname(result.entry))
const fromGpuix = Bun.resolveSync('react', path.dirname(Bun.resolveSync('@gpuix/react', APP_DIR)))
const fromRendererDir = Bun.resolveSync('react', path.join(APP_DIR, '../../src/renderer'))
const version = (await import(fromBundle)).version as string
console.log(`react from the bundle dir: ${path.relative(APP_DIR, fromBundle)} (${version})`)
console.log(`react from @gpuix/react:   ${path.relative(APP_DIR, fromGpuix)}`)
console.log(
  `react from src/renderer without the bundler: ${path.relative(APP_DIR, fromRendererDir)} (what the bundle avoids)`
)
if (fromBundle !== fromGpuix) fail('the bundle and @gpuix/react would load different react files')
if (!version.startsWith('19.')) fail(`react is ${version}, expected 19.x`)

console.log(failed ? 'FAIL: more than one React, or the wrong one' : 'PASS: one React 19 instance')
process.exit(failed ? 1 : 0)
