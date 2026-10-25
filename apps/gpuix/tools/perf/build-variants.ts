/**
 * Build the GPUIX bundles that `ab.ts` compares, from the working tree, each
 * with a fixed set of source edits applied at bundle time. The checkout is not
 * modified, so every variant is reproducible from one commit.
 *
 *   bun tools/perf/build-variants.ts            # every variant
 *   bun tools/perf/build-variants.ts base       # just these
 *
 * Variants (output dir in parentheses):
 * - `park` (dist): the branch as committed.
 * - `base` (dist-sbase): `parkHiddenPanes` does nothing, so hidden panes stay
 *   in the GPUI frame as on exp/gpuix-client before F3.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { BunPlugin } from 'bun'
import { APP_DIR, buildClient, ENTRY } from '../../build'

/** Replace `from` with `to`, or the whole file with its text at git revision `rev`. */
type Edit = { file: string; from: string; to: string } | { file: string; rev: string }

const PARK = path.join(APP_DIR, 'src/compat/park.ts')

const VARIANTS: Record<string, { outdir: string; edits: Edit[] }> = {
  park: { outdir: 'dist', edits: [] },
  base: {
    outdir: 'dist-sbase',
    edits: [
      {
        file: PARK,
        from: 'export function parkHiddenPanes(renderer: BatchRenderer): Parking {',
        to: 'export function parkHiddenPanes(_renderer: BatchRenderer): Parking {\n  return { parked: () => 0, uninstall() {} }\n}\nexport function unusedParkHiddenPanes(renderer: BatchRenderer): Parking {'
      }
    ]
  }
}

function sourceEdits(edits: Edit[]): BunPlugin {
  const byFile = new Map<string, Edit[]>()
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit])
  const escaped = [...byFile.keys()].map((file) => file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
  return {
    name: 'perf-variant-edits',
    setup(build) {
      if (escaped.length === 0) return
      build.onLoad({ filter: new RegExp(`^(${escaped.join('|')})$`) }, async (args) => {
        let text = readFileSync(args.path, 'utf8')
        for (const edit of byFile.get(args.path) ?? []) {
          if ('rev' in edit) {
            text = await Bun.$`git show ${edit.rev}:./${path.relative(APP_DIR, edit.file)}`
              .cwd(APP_DIR)
              .text()
            continue
          }
          if (!text.includes(edit.from))
            throw new Error(
              `variant edit no longer matches ${path.relative(APP_DIR, edit.file)}: ${edit.from}`
            )
          text = text.replace(edit.from, edit.to)
        }
        return { contents: text, loader: args.path.endsWith('x') ? 'tsx' : 'ts' }
      })
    }
  }
}

const wanted = Bun.argv.slice(2)
const names = wanted.length > 0 ? wanted : Object.keys(VARIANTS)
for (const name of names) {
  const variant = VARIANTS[name]
  if (!variant)
    throw new Error(`unknown variant ${name}; known: ${Object.keys(VARIANTS).join(', ')}`)
  const outdir = path.join(APP_DIR, variant.outdir)
  const result = await buildClient(ENTRY, outdir, {
    production: true,
    plugins: [sourceEdits(variant.edits)]
  })
  for (const line of result.logs) console.error(line)
  if (!result.ok) process.exit(1)
  console.log(`[variants] ${name} -> ${variant.outdir}`)
}
