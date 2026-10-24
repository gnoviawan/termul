/**
 * `bun tools/parity/workspace-checks.ts [--port N]`
 *
 * Drives the GPUIX client on the seeded workspace and asserts what a user
 * sees: project switching, the command palette's Ctrl+K and Escape, the
 * desktop keymap (Ctrl+, and Ctrl+R, not the web's Alt+,), and a window
 * resize reflowing the shell. Exits non-zero on the first failed assertion.
 */

import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient } from '../../build'
import { startTestServer } from './server'
import { grabFrame, READY_TIMEOUT_MS, windowOrigin, withGpuix } from './shoot-gpuix'
import { seedWorkspace } from './workspace'

type GpuixApp = Parameters<Parameters<typeof withGpuix>[1]>[0]['app']

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '8196' },
    'state-dir': { type: 'string' },
    out: {
      type: 'string',
      default: path.join(import.meta.dir, '../../parity-out/workspace-checks')
    }
  }
})
const stateDir =
  values['state-dir'] ?? path.join(os.tmpdir(), 'gpuix-workspace-checks', values.port)

function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected)
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  console.log(`ok  ${what}: ${JSON.stringify(actual)}`)
}

async function paintedCount(app: GpuixApp, text: string, present: boolean): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const n = await app.getByText(text).count()
    if (n > 0 === present || Date.now() > deadline) return n
    await Bun.sleep(100)
  }
}

async function width(app: GpuixApp, testId: string, not?: number): Promise<number> {
  const deadline = Date.now() + 5000
  for (;;) {
    const bounds = await app.getByTestId(testId).bounds()
    if (bounds.width !== not || Date.now() > deadline) return Math.round(bounds.width)
    await Bun.sleep(100)
  }
}

const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
const server = await startTestServer({
  port: Number(values.port),
  token: 'checks-token',
  stateDir: path.join(stateDir, 'server')
})
let failed = false
try {
  await seedWorkspace(server)
  const size = { width: 1280, height: 800 }
  await withGpuix(
    { server, entry: build.entry, clientStateDir: path.join(stateDir, 'client'), ...size },
    async ({ app, display, grab }) => {
      await mkdir(values.out, { recursive: true })
      const heading = app.getByText('What should we do in alpha?')
      await heading.waitFor({ timeoutMs: READY_TIMEOUT_MS })
      assertEqual(
        await heading.textContent(),
        'What should we do in alpha?',
        'dashboard heading at start'
      )

      await app.getByTestId('project-item-parity-beta').click()
      const beta = app.getByText('What should we do in beta?')
      await beta.waitFor({ timeoutMs: 5000 })
      assertEqual(
        await beta.textContent(),
        'What should we do in beta?',
        'dashboard heading after clicking beta'
      )
      assertEqual(
        await app.getByText('What should we do in alpha?').count(),
        0,
        'alpha heading gone'
      )

      await app.call('keystrokes', { keys: 'ctrl-k' })
      assertEqual(
        await paintedCount(app, 'App Preferences', true),
        1,
        'Ctrl+K: palette items painted'
      )
      await app.call('keystrokes', { keys: 'escape' })
      assertEqual(await paintedCount(app, 'App Preferences', false), 0, 'Escape: palette closed')

      await app.call('keystrokes', { keys: 'alt-,' })
      await Bun.sleep(500)
      assertEqual(
        await app.getByText('Interface zoom').count(),
        0,
        'Alt+, (web keymap) does nothing on the desktop keymap'
      )
      await app.call('keystrokes', { keys: 'ctrl-,' })
      assertEqual(
        await paintedCount(app, 'Interface zoom', true),
        1,
        'Ctrl+,: settings open on its first section'
      )
      assertEqual(await app.getByText('Preferences').textContent(), 'Preferences', 'settings title')
      await app.call('keystrokes', { keys: 'escape' })
      assertEqual(await paintedCount(app, 'Interface zoom', false), 0, 'Escape: settings closed')

      await app.call('keystrokes', { keys: 'ctrl-r' })
      assertEqual(
        await paintedCount(app, 'No command history yet', true),
        1,
        'Ctrl+R: command history opens (desktop-only binding)'
      )
      await app.call('keystrokes', { keys: 'escape' })
      assertEqual(
        await paintedCount(app, 'No command history yet', false),
        0,
        'Escape: command history closed'
      )

      const rowBefore = await width(app, 'shell-row')
      const railBefore = await width(app, 'shell-rail')
      await grab(path.join(values.out, 'before-resize-1280x800.png'))
      const resize = Bun.spawnSync(
        [
          'uv',
          'run',
          '--quiet',
          '--with',
          'python-xlib==0.33',
          'python',
          '-I',
          path.join(import.meta.dir, 'resize-window.py'),
          `${size.width}x${size.height}`,
          '1000x700'
        ],
        { env: { ...process.env, DISPLAY: display } }
      )
      if (resize.exitCode !== 0) throw new Error(`resize failed: ${resize.stderr.toString()}`)
      const rowAfter = await width(app, 'shell-row', rowBefore)
      await Bun.sleep(400)
      const after = path.join(values.out, 'after-resize-1000x700.png')
      await grabFrame(display, 1000, 700, after, await windowOrigin(display, 1000, 700))
      console.log(`    frames: ${path.join(values.out, 'before-resize-1280x800.png')} ${after}`)
      assertEqual(rowBefore, size.width - railBefore, 'shell row width at 1280')
      assertEqual(rowAfter, 1000 - railBefore, 'shell row width after resizing to 1000x700')
      assertEqual(
        await width(app, 'shell-rail'),
        railBefore,
        'rail width kept (desktop shell, not mobile)'
      )
    }
  )
} catch (error) {
  failed = true
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.stop()
  await rm(stateDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
