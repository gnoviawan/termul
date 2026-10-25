/**
 * Do GPUI's file dialogs work end to end on Linux? Runs `dialog-scene.tsx`
 * under Xvfb with a private session bus, so the requests reach
 * xdg-desktop-portal and its GTK backend, and answers each GTK chooser with
 * real key events (`tools/matrix/x11-file-chooser.py`): an open dialog picks
 * a file, a save dialog (native patch gpuix/0008) gets a new path, and a
 * second open is cancelled. Prints one PASS or FAIL line per dialog.
 *
 * bun tools/native/dialog-check.ts [--out DIR]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { answerFileChooser } from '../matrix/drive'
import { LAVAPIPE_ICD, startSessionBus, startXvfb } from '../parity/shoot-gpuix'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: '/tmp/gpuix-dialog-check' } }
})
const out = path.resolve(values.out as string)
rmSync(out, { recursive: true, force: true })
mkdirSync(path.join(out, 'saves'), { recursive: true })
const picked = path.join(out, 'pick-me.txt')
writeFileSync(picked, 'picked\n')
const saveTo = path.join(out, 'saves', 'renamed.conf')

const xvfb = await startXvfb(1400, 1000)
const bus = await startSessionBus(xvfb.display)
let failed = false
try {
  if (!bus.address) throw new Error('no dbus-daemon: the portal needs a session bus')
  const scene = Bun.spawn(
    ['bun', path.join(import.meta.dir, 'dialog-scene.tsx'), out, path.join(out, 'saves')],
    {
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        DBUS_SESSION_BUS_ADDRESS: bus.address,
        VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
        GPUIX_BACKGROUND: '1'
      },
      stdout: 'inherit',
      stderr: 'inherit'
    }
  )
  await answerFileChooser(xvfb.display, 'Open File', picked)
  await answerFileChooser(xvfb.display, 'Save File', saveTo)
  await answerFileChooser(xvfb.display, 'Open File', '')
  const deadline = Date.now() + 20_000
  const resultFile = path.join(out, 'result.json')
  while (!existsSync(resultFile)) {
    if (scene.exitCode !== null && !existsSync(resultFile))
      throw new Error(`dialog scene exited ${scene.exitCode}`)
    if (Date.now() > deadline) throw new Error('no result.json')
    await Bun.sleep(50)
  }
  const result = JSON.parse(readFileSync(resultFile, 'utf8'))
  const rows = [
    { what: 'open dialog returns the picked file', value: result.open, want: { value: [picked] } },
    { what: 'save dialog returns the typed new path', value: result.save, want: { value: saveTo } },
    { what: 'a cancelled open dialog resolves null', value: result.cancel, want: { value: null } }
  ]
  for (const row of rows) {
    const ok = JSON.stringify(row.value) === JSON.stringify(row.want)
    failed ||= !ok
    console.log(`${ok ? 'PASS' : 'FAIL'} ${row.what}: ${JSON.stringify(row.value)}`)
  }
} catch (error) {
  failed = true
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  bus.stop()
  xvfb.stop()
}
if (failed) process.exit(1)
