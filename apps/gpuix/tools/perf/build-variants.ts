/**
 * Build the GPUIX bundles that `ab.ts` compares, from the working tree, each
 * with a fixed set of source edits applied at bundle time. The checkout is not
 * modified, so every variant is reproducible from one commit.
 *
 *   bun tools/perf/build-variants.ts                 # every variant
 *   bun tools/perf/build-variants.ts base nopoll     # just these
 *
 * Variants (output dir in parentheses):
 * - `park` (dist): the branch as committed.
 * - `base` (dist-sbase): `parkHiddenPanes` does nothing, so hidden panes stay
 *   in the GPUI frame as on exp/gpuix-client before F3.
 * - `nopoll` (dist-snopoll): the transcript's `getListScrollTop` poll never
 *   runs (an experiment for the chat owner, not a proposed build).
 *
 * Every variant carries `scrollGuard`: the transcript's poll returns instead
 * of throwing when GPUIX's 2 s sync-read timeout fires. That is G2's fix on its
 * own branch; the edit is skipped once the source already guards the call.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { BunPlugin } from 'bun'
import { APP_DIR, buildClient, ENTRY } from '../../build'

interface Edit {
  file: string
  from: string
  to: string
  /** Skip instead of failing when `from` is absent (the source already has the change). */
  optional?: boolean
}

const PARK = path.join(APP_DIR, 'src/compat/park.ts')
const LIST = path.join(APP_DIR, 'src/overrides/components/chat/ChatMessageList.tsx')

const scrollGuard: Edit = {
  file: LIST,
  from: 'const top = renderer.getListScrollTop?.(id)',
  to: 'let top: number[] | null | undefined\n      try {\n        top = renderer.getListScrollTop?.(id)\n      } catch {\n        return\n      }',
  optional: true
}

const VARIANTS: Record<string, { outdir: string; edits: Edit[] }> = {
  park: { outdir: 'dist', edits: [scrollGuard] },
  base: {
    outdir: 'dist-sbase',
    edits: [
      scrollGuard,
      {
        file: PARK,
        from: 'export function parkHiddenPanes(renderer: BatchRenderer): Parking {',
        to: 'export function parkHiddenPanes(_renderer: BatchRenderer): Parking {\n  return { parked: () => 0, uninstall() {} }\n}\nexport function unusedParkHiddenPanes(renderer: BatchRenderer): Parking {'
      }
    ]
  },
  nopoll: {
    outdir: 'dist-snopoll',
    edits: [
      scrollGuard,
      {
        file: LIST,
        from: 'setInterval(read, FOLLOW_POLL_MS)',
        to: 'setInterval(() => {}, FOLLOW_POLL_MS)'
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
      build.onLoad({ filter: new RegExp(`^(${escaped.join('|')})$`) }, (args) => {
        let text = readFileSync(args.path, 'utf8')
        for (const edit of byFile.get(args.path) ?? []) {
          if (!text.includes(edit.from)) {
            if (edit.optional) continue
            throw new Error(
              `variant edit no longer matches ${path.relative(APP_DIR, edit.file)}: ${edit.from}`
            )
          }
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
