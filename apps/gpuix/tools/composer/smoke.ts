/** `bun tools/composer/smoke.ts [out.png]`: seed, open the scene, grab one frame. */

import { seedComposerServer } from './seed'
import { withScene } from './scene/session'

const out = Bun.argv[2] ?? '/tmp/gpuix-o3/smoke.png'
const seeded = await seedComposerServer()
try {
  await withScene(seeded, { x: 240, y: 560, width: 800 }, async ({ grab, sessionId }) => {
    console.log(`session ${sessionId}`)
    await grab(out)
  })
  console.log(`wrote ${out}`)
} finally {
  await seeded.stop()
}
