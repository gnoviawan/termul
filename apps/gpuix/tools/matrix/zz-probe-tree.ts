import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { buildClient } from '../../build'
import { withGpuix } from '../parity/shoot-gpuix'
import { createWorld } from './world'

const [hash, needle, root = '/tmp/gpuix-g15/probe'] = process.argv.slice(2)
rmSync(root, { recursive: true, force: true })
const build = await buildClient()
if (!build.ok) throw new Error(build.logs.join('\n'))
const world = await createWorld({ port: 8197, root })
const clientStateDir = path.join(root, 'client')
mkdirSync(clientStateDir, { recursive: true })
type N = { id: number; type: string; text?: string; testId?: string; style?: Record<string, unknown>; bounds?: unknown; children?: N[] }
try {
  await withGpuix({ server: world.server, entry: build.entry, clientStateDir, width: 1280, height: 800, env: { GPUIX_START_HASH: hash } }, async ({ app }) => {
    await app.getByText(needle).waitFor({ timeoutMs: 60_000 })
    await Bun.sleep(1500)
    const { tree } = (await app.call('getTree', {})) as { tree: N }
    const chain: N[] = []
    const find = (n: N, path: N[]): boolean => {
      if (n.text?.includes(needle)) { chain.push(...path, n); return true }
      return (n.children ?? []).some((c) => find(c, [...path, n]))
    }
    find(tree, [])
    for (const n of chain.slice(-14)) console.log(n.type, n.testId ?? '', JSON.stringify(n.bounds), JSON.stringify(n.style ?? {}).slice(0, 300))
  })
} finally {
  await world.server.stop?.()
}
process.exit(0)
