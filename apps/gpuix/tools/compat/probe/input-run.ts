/** Runs `input.tsx` under Xvfb and prints the event log. */
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { LAVAPIPE_ICD, startXvfb } from '../../parity/shoot-gpuix'

const LOG = process.env.PROBE_LOG ?? '/tmp/gpuix-g1/input-probe.log'
rmSync(LOG, { force: true })
const xvfb = await startXvfb(700, 400)
const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, 'input.tsx')],
  cwd: import.meta.dir,
  env: {
    ...process.env,
    DISPLAY: xvfb.display,
    VK_ICD_FILENAMES: LAVAPIPE_ICD,
    GPUIX_BACKGROUND: '1',
    PROBE_LOG: LOG
  }
})
try {
  const input = app.getByTestId('in')
  await input.waitFor({ timeoutMs: 30000 })
  await input.click()
  for (const key of ['a', 'enter', 'up', 'down', 'escape', 'tab']) {
    appendFileSync(LOG, `--- ${key}\n`)
    await app.call('keystrokes', { keys: key })
    await Bun.sleep(150)
  }
} finally {
  await app.close()
  xvfb.stop()
}
console.log(readFileSync(LOG, 'utf8'))
