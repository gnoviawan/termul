/**
 * Web reference shots of the editor: src/app.ts and README.md opened from
 * the Explorer, plus the editor's measured geometry.
 *
 * bun tools/editor/web-shot.ts [--out DIR]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { startTestServer } from '../parity/server'
import { withWeb } from '../parity/shoot-web'
import { freePort, SIZE, STATE_ROOT, seedEditorProject, webOpenFile } from './scenario'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: path.join(STATE_ROOT, 'web') } }
})
const OUT = values.out!
await mkdir(OUT, { recursive: true })
const server = await startTestServer({
  port: await freePort(),
  token: 'e1-web-token',
  stateDir: path.join(STATE_ROOT, 'web-server')
})
try {
  await seedEditorProject(server)
  await withWeb({ server, ...SIZE }, async ({ page, grab }) => {
    await webOpenFile(page, ['src', 'app.ts'])
    await page.locator('.cm-content').first().waitFor({ timeout: 30_000 })
    await grab(path.join(OUT, 'app-ts.png'))
    const geometry = await page.evaluate(() => {
      const box = (sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`,
          color: cs.color,
          bg: cs.backgroundColor,
          padding: cs.padding
        }
      }
      return {
        editor: box('.cm-editor'),
        scroller: box('.cm-scroller'),
        gutters: box('.cm-gutters'),
        lineNumbers: box('.cm-lineNumbers'),
        lineNumber: box('.cm-lineNumbers .cm-gutterElement:nth-child(2)'),
        foldGutter: box('.cm-foldGutter'),
        foldMarker: box('.cm-foldGutter .cm-gutterElement:nth-child(7)'),
        content: box('.cm-content'),
        line1: box('.cm-line'),
        activeLine: box('.cm-activeLine'),
        cursor: box('.cm-cursor'),
        tabBar: box('[role="tablist"]'),
        foldText: Array.from(document.querySelectorAll('.cm-foldGutter .cm-gutterElement'))
          .map((e) => e.textContent)
          .join('|')
      }
    })
    await writeFile(path.join(OUT, 'geometry.json'), JSON.stringify(geometry, null, 2))
    await webOpenFile(page, ['README.md'])
    await page.waitForTimeout(1500)
    await grab(path.join(OUT, 'readme.png'))
  })
} finally {
  await server.stop()
}
console.log(`wrote ${OUT}`)
