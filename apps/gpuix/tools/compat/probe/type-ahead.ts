/**
 * Probe for C11: where do keys typed straight after Ctrl+K go in GPUIX?
 * Seeds the matrix world, boots the client, sends `ctrl-k` then `theme` as
 * two keystroke calls (back to back, or `$PROBE_GAP_MS` apart), and grabs a frame
 * with the palette open and another after Escape closes it, so a stray
 * "theme" in the composer shows. Frames go to `$PROBE_OUT`.
 *
 *   bun tools/compat/probe/type-ahead.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildClient } from '../../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import { createWorld, prepareDevice, setTheme } from '../../matrix/world'
import { READY_TIMEOUT_MS, withGpuix } from '../../parity/shoot-gpuix'
import { pickPort } from '../../shared/seed'

const OUT = process.env.PROBE_OUT ?? '/tmp/gpuix-g1/type-ahead'
const STATE = process.env.PROBE_STATE ?? '/tmp/gpuix-g1/probe-state'
const GAP_MS = Number(process.env.PROBE_GAP_MS ?? 0)
rmSync(STATE, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const build = await buildClient()
if (!build.ok) throw new Error(build.logs.join('\n'))
const world = await createWorld({ port: await pickPort(), root: path.join(STATE, 'world') })
try {
  const deviceId = 'probe-type-ahead'
  await prepareDevice(world, deviceId)
  await setTheme(world, 'termul', 'dark')
  const clientStateDir = path.join(STATE, 'client')
  const host = new URL(world.server.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
  mkdirSync(path.join(clientStateDir, 'web-storage'), { recursive: true })
  writeFileSync(
    path.join(clientStateDir, 'web-storage', `${host}.json`),
    JSON.stringify({ 'termul.deviceId': deviceId })
  )
  await withGpuix(
    {
      server: world.server,
      entry: build.entry,
      clientStateDir,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT
    },
    async ({ app, grab }) => {
      await app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await Bun.sleep(500)
      await app.call('keystrokes', { keys: 'ctrl-k' })
      if (GAP_MS > 0) await Bun.sleep(GAP_MS)
      await app.call('keystrokes', { keys: 't h e m e' })
      await Bun.sleep(1500)
      await grab(path.join(OUT, 'open.png'))
      const { text } = await app.call('getAllText', {})
      console.log('palette filtered:', !String(text).includes('New Terminal'))
      await app.call('keystrokes', { keys: 'escape' })
      await Bun.sleep(800)
      await grab(path.join(OUT, 'closed.png'))
    }
  )
} finally {
  world.ws.close()
  await world.server.stop()
  rmSync(STATE, { recursive: true, force: true })
}
console.log(`frames in ${OUT}`)
