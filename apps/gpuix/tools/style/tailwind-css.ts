/**
 * Compiles class names with Termul's real stylesheet (src/renderer/index.css,
 * tailwind.config.ts) through Tailwind's own compiler. The showcase page and
 * the oracle checks use this so the web side is the renderer's CSS, not a copy.
 * Needs the repo root node_modules (a symlink to the main checkout's is fine).
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REPO = resolve(import.meta.dir, '../../../..')
const RENDERER = join(REPO, 'src/renderer')

export async function compileTailwind(classes: Iterable<string>): Promise<string> {
  const { compile } = (await import(
    join(REPO, 'node_modules/@tailwindcss/node/dist/index.mjs')
  )) as typeof import('@tailwindcss/node')
  const css = readFileSync(join(RENDERER, 'index.css'), 'utf8')
  const compiler = await compile(css, {
    base: RENDERER,
    from: join(RENDERER, 'index.css'),
    onDependency: () => {}
  })
  return compiler.build([...classes])
}

if (import.meta.main) {
  const out = await compileTailwind(process.argv.slice(2))
  console.log(out)
}
