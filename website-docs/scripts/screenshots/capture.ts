import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startDemoServer } from './demo-server'
import type { Shot } from './shot'

// Usage: bun scripts/screenshots/capture.ts [id-substring ...]
// Starts an isolated troupe-server with demo projects, runs every shot in
// shots/*.ts, and writes PNGs to public/screenshots/.

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '..', 'public', 'screenshots')
const filters = process.argv.slice(2)

const groups: Array<{ file: string; shots: Shot[] }> = []
for (const file of (await readdir(join(here, 'shots'))).filter((f) => f.endsWith('.ts')).sort()) {
  const mod: { shots: Shot[] } = await import(join(here, 'shots', file))
  groups.push({ file, shots: mod.shots })
}
const ids = new Set<string>()
for (const shot of groups.flatMap((g) => g.shots)) {
  if (ids.has(shot.id)) throw new Error(`duplicate shot id ${shot.id}`)
  ids.add(shot.id)
}
const wanted = (shot: Shot): boolean =>
  filters.length === 0 || filters.some((f) => shot.id.includes(f))
const selected = groups.flatMap((g) => g.shots).filter(wanted)

const browser = await chromium.launch()
const failures: string[] = []
try {
  // Each shots file gets a fresh server and demo workspace, so one section's
  // chats and terminals never leak into another section's screenshots.
  for (const group of groups) {
    const shots = group.shots.filter(wanted)
    if (shots.length === 0) continue
    const server = await startDemoServer()
    try {
      for (const shot of shots) await capture(shot)
    } finally {
      await server.stop()
    }
  }
} finally {
  await browser.close()
}

async function capture(shot: Shot): Promise<void> {
  const context = await browser.newContext({
    viewport: shot.viewport ?? { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'dark'
  })
  const page = await context.newPage()
  try {
    const target = await shot.run(page)
    await page.waitForTimeout(400)
    const path = join(outDir, `${shot.id}.png`)
    if (target) await target.screenshot({ path })
    else await page.screenshot({ path })
    console.log(`ok   ${shot.id}`)
  } catch (error) {
    failures.push(shot.id)
    console.error(
      `FAIL ${shot.id}: ${error instanceof Error ? error.message.split('\n')[0] : error}`
    )
  } finally {
    await context.close()
  }
}

console.log(`${selected.length - failures.length}/${selected.length} shots captured`)
if (failures.length) process.exit(1)
