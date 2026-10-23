/** Runs `probe.tsx` under Xvfb and prints the event log. */
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { LAVAPIPE_ICD, startXvfb } from '../../parity/shoot-gpuix'

const LOG = '/tmp/gpuix-o3/probe.log'
rmSync(LOG, { force: true })
const xvfb = await startXvfb(900, 700)
const app = await launch({
  command: 'bun',
  args: [path.join(import.meta.dir, 'probe.tsx')],
  cwd: import.meta.dir,
  env: {
    ...process.env,
    DISPLAY: xvfb.display,
    VK_ICD_FILENAMES: LAVAPIPE_ICD,
    GPUIX_BACKGROUND: '1',
    PROBE_LOG: LOG
  }
})
const mark = (m: string) => appendFileSync(LOG, `--- ${m}\n`)
try {
  const ta = app.getByTestId('ta')
  await ta.waitFor({ timeoutMs: 30000 })
  for (const key of [
    'a',
    '@',
    'b',
    'backspace',
    'left',
    'right',
    'up',
    'down',
    'shift-enter',
    'enter',
    'tab',
    'ctrl-v'
  ]) {
    mark(`ta ${key}`)
    await ta.press(key)
    await Bun.sleep(120)
  }
  mark('ta escape (external set + simulated caret move), then X')
  await ta.press('escape')
  await Bun.sleep(400)
  await ta.press('X')
  await Bun.sleep(200)
  const kd = app.getByTestId('kd')
  for (const key of [
    'a',
    '@',
    'shift-2',
    'backspace',
    'left',
    'up',
    'enter',
    'shift-enter',
    'ctrl-v',
    'tab'
  ]) {
    mark(`kd ${key}`)
    await kd.press(key)
    await Bun.sleep(120)
  }
} finally {
  await app.close()
  xvfb.stop()
}
console.log(readFileSync(LOG, 'utf8'))
