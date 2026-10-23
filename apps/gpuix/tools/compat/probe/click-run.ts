import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { LAVAPIPE_ICD, startXvfb } from '../../parity/shoot-gpuix'

const xvfb = await startXvfb(1280, 800)
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'click.tsx')], cwd: import.meta.dir, env: { ...process.env, DISPLAY: xvfb.display, VK_ICD_FILENAMES: LAVAPIPE_ICD, GPUIX_BACKGROUND: '1' } })
try {
  for (const id of ['child-bg', 'child-hover', 'child-click', 'child-auto', 'child-abs', 'child-f', 'child-g', 'mid-g']) {
    await app.getByTestId(id).waitFor({ timeoutMs: 30000 })
    await app.getByTestId(id).click()
    await Bun.sleep(150)
  }
  await Bun.sleep(300)
} finally {
  const logs = await app.close()
  console.log(JSON.stringify(logs)?.slice(0, 3000))
  xvfb.stop()
}
