/**
 * Drive the GPUIX ui gallery through @gpuix/react/automation and assert what a
 * user would see: overlays opening and closing, and the event each control
 * reports (painted into the `event-log` cell).
 *
 *   bun tools/ui/gallery/interact.ts
 */
import path from 'node:path'
import { APP_DIR } from '../../../build'
import type { TestServer } from '../../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../../parity/shoot-gpuix'
import { buildGpuixGallery } from './build'
import { GALLERY_HEIGHT, GALLERY_WIDTH, type SceneId } from './layout'

type App = Parameters<Parameters<typeof withGpuix>[1]>[0]['app']

const NO_SERVER: TestServer = {
  baseUrl: 'http://127.0.0.1:9',
  token: '',
  stateDir: '/tmp/gpuix-k1',
  stop: async () => {}
}
const entry = await buildGpuixGallery(path.join(APP_DIR, 'dist/gallery'))

let failures = 0

function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`
  )
}

async function until(
  read: () => Promise<unknown>,
  expected: unknown,
  timeoutMs = 3000
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (value !== expected && Date.now() < deadline) {
    await Bun.sleep(50)
    value = await read()
  }
  return value
}

async function scene(id: SceneId, body: (app: App) => Promise<void>) {
  process.env.GALLERY_SCENE = id
  process.env.GALLERY_INTERACTIVE = '1'
  process.env.TERMUL_GPUIX_REDUCED_MOTION = '1'
  await withGpuix(
    {
      server: NO_SERVER,
      entry,
      width: GALLERY_WIDTH,
      height: GALLERY_HEIGHT,
      clientStateDir: '/tmp/gpuix-k1/client-state'
    },
    async ({ app }) => {
      await app.getByTestId('gallery-ready').waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await body(app)
    }
  )
}

const count = (app: App, testId: string) => () => app.getByTestId(testId).count()
const log = (app: App) => () => app.getByTestId('event-log').textContent()

await scene('dialog', async (app) => {
  check('dialog closed before the click', await app.getByTestId('dialog-content').count(), 0)
  await app.getByTestId('dialog-trigger').click()
  check('dialog opens on trigger click', await until(count(app, 'dialog-content'), 1), 1)
  await app.getByTestId('dialog-content').press('escape')
  check('dialog closes on Escape', await until(count(app, 'dialog-content'), 0), 0)
  check('dialog reports onOpenChange(false)', await until(log(app), 'dialog:false'), 'dialog:false')
})

await scene('dropdown', async (app) => {
  await app.getByTestId('dropdown-trigger').press('enter')
  check('dropdown opens from the keyboard', await until(count(app, 'dropdown-content'), 1), 1)
  await app.getByTestId('dropdown-content').press('down')
  await app.getByTestId('dropdown-content').press('enter')
  check(
    'ArrowDown + Enter selects the 2nd item',
    await until(log(app), 'select:duplicate'),
    'select:duplicate'
  )
  check('dropdown closes after the selection', await until(count(app, 'dropdown-content'), 0), 0)
  await app.getByTestId('dropdown-trigger').click()
  check('dropdown opens on press', await until(count(app, 'dropdown-content'), 1), 1)
  await app.getByTestId('menu-archive').click()
  check('clicking an item selects it', await until(log(app), 'select:archive'), 'select:archive')
})

await scene('popover', async (app) => {
  await app.getByTestId('popover-trigger').click()
  check('popover opens on trigger click', await until(count(app, 'popover-content'), 1), 1)
  await app.mouse.click({ x: 1000, y: 600 })
  check('outside click closes the popover', await until(count(app, 'popover-content'), 0), 0)
  check(
    'popover reports onOpenChange(false)',
    await until(log(app), 'popover:false'),
    'popover:false'
  )
})

await scene('controls', async (app) => {
  await app.getByTestId('switch-off').click()
  check(
    'switch click fires onCheckedChange(true)',
    await until(log(app), 'switch:true'),
    'switch:true'
  )
})

await scene('select', async (app) => {
  await app.getByTestId('select-trigger').click()
  check('select opens on press', await until(count(app, 'select-content'), 1), 1)
  await app.getByTestId('select-content').press('down')
  await app.getByTestId('select-content').press('enter')
  check(
    'ArrowDown + Enter moves from Opus to Haiku',
    await until(log(app), 'value:haiku'),
    'value:haiku'
  )
  check(
    'select trigger shows the new label',
    await until(() => app.getByTestId('select-trigger').textContent(), 'Claude Haiku'),
    'Claude Haiku'
  )
})

console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
