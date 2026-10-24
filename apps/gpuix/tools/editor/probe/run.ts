/**
 * Runs `probe.tsx` in each mode under Xvfb and prints the reports.
 *
 * bun tools/editor/probe/run.ts [textarea|rows ...]
 */
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { LAVAPIPE_ICD, startXvfb } from '../../parity/shoot-gpuix'

const STATE = process.env.GPUIX_STATE_ROOT ?? '/tmp/gpuix-e1'
const modes = Bun.argv.slice(2).length ? Bun.argv.slice(2) : ['textarea', 'rows']
for (const mode of modes) {
  const out = path.join(STATE, `probe-${mode}.json`)
  rmSync(out, { force: true })
  const xvfb = await startXvfb(1100, 800)
  try {
    const child = Bun.spawn(['bun', path.join(import.meta.dir, 'probe.tsx')], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        VK_ICD_FILENAMES: LAVAPIPE_ICD,
        GPUIX_BACKGROUND: '1',
        PROBE_MODE: mode,
        PROBE_OUT: out
      },
      stdout: 'inherit',
      stderr: 'inherit'
    })
    const timer = setTimeout(() => child.kill(), 120_000)
    await child.exited
    clearTimeout(timer)
  } finally {
    xvfb.stop()
  }
  console.log(readFileSync(out, 'utf8'))
}
