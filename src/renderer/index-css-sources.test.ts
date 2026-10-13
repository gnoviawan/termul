import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from '@tailwindcss/postcss'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'index.css')

describe('index.css through Tailwind', () => {
  // Vite's url-rewrite step warns "A PostCSS plugin did not pass the `from`
  // option to `postcss.parse`" for any declaration without a source file.
  // Tailwind emits keyframes from the JS config (@config) that way, so they
  // belong in index.css (@theme), not tailwind.config.ts.
  it('gives every generated declaration a source file', async () => {
    const result = await postcss([tailwind()]).process(readFileSync(cssPath, 'utf8'), {
      from: cssPath
    })
    const sourceless: string[] = []
    result.root.walkDecls((decl) => {
      if (decl.source?.input.file) return
      const rule = decl.parent as { selector?: string; parent?: { params?: string } } | undefined
      sourceless.push(`${rule?.parent?.params ?? ''} ${rule?.selector ?? ''} { ${decl.prop} }`)
    })
    expect(sourceless).toEqual([])
  }, 60_000)
})
