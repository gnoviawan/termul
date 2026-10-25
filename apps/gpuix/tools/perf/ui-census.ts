/**
 * Who holds the GPUIX UI thread under the stream-storm load? Opens `chats`
 * streaming chats, then measures the `gpuix-ui` thread over windows that each
 * add one actor: nothing, the harness's tree polling, chat switches, typing.
 * Windows only (thread CPU from win32.ts).
 *
 *   bun tools/perf/ui-census.ts <termul-server.exe> [chats=8] [windowS=8]
 */
import { readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TreeNode } from '@gpuix/native/automation'
import { gpuixDriver, launchGpuix } from './clients/gpuix.ts'
import { startPerfServer } from './server.ts'
import { threadTicks } from './win32.ts'

const [bin, chatsArg, windowArg] = process.argv.slice(2)
if (!bin) throw new Error('usage: ui-census.ts <termul-server.exe> [chats] [windowS]')
const chats = Number(chatsArg ?? 8)
const windowS = Number(windowArg ?? 8)
const scratch = path.join(os.tmpdir(), 'gpuixcensus')
const frameStats = path.join(os.tmpdir(), 'gpuixcensus-frames.jsonl')
rmSync(frameStats, { force: true })
process.env.TERMUL_GPUIX_FRAME_STATS = frameStats

const server = await startPerfServer({
  binary: bin,
  port: 8302,
  stateRoot: scratch,
  agentEnv: {
    PERF_AGENT_SEED: '42',
    PERF_AGENT_RATE: '20',
    PERF_AGENT_CHUNK_CHARS: '120',
    PERF_AGENT_UNIQUE_SESSIONS: '1'
  }
})
const handle = await launchGpuix({
  url: server.baseUrl,
  display: '',
  width: 1440,
  height: 900,
  distWeb: '',
  gl: 'gpu',
  noPageMetrics: true,
  clientStateDir: path.join(scratch, 'client')
})
const driver = gpuixDriver(handle)
const pids = new Set([handle.rootPid])

interface FrameLine {
  t: number
  frames: number
  p90Ms?: number
  maxMs?: number
}
const frameLines = (from: number, to: number): FrameLine[] =>
  readFileSync(frameStats, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as FrameLine)
    .filter((l) => l.t >= from && l.t <= to)

/** gpuix-ui CPU in % of one core, frames per second and draw times while `actor` runs. */
async function measure(name: string, actor: (until: number) => Promise<string>): Promise<void> {
  const a = threadTicks(pids)
  const t0 = Date.now()
  const note = await actor(t0 + windowS * 1000)
  const t1 = Date.now()
  const seconds = (t1 - t0) / 1000
  const b = threadTicks(pids)
  const lines = frameLines(t0, t1 + 1000)
  const fps =
    lines.length > 1
      ? (lines.at(-1)!.frames - lines[0].frames) / ((lines.at(-1)!.t - lines[0].t) / 1000)
      : 0
  const p90 = Math.max(...lines.map((l) => l.p90Ms ?? 0))
  const max = Math.max(...lines.map((l) => l.maxMs ?? 0))
  const ui =
    [...b]
      .filter(([, v]) => v.comm === 'gpuix-ui')
      .reduce((s, [k, v]) => s + (v.ticks - (a.get(k)?.ticks ?? 0)), 0) /
    1e7 /
    seconds
  console.log(
    `${name.padEnd(8)} ui=${(ui * 100).toFixed(1)}% fps=${fps.toFixed(1)} draw p90<=${p90.toFixed(1)}ms max=${max.toFixed(1)}ms ${note}`
  )
}

const tree = async () => (await handle.app.call('getTree', {})).tree as TreeNode
const walk = (n: TreeNode | null | undefined, f: (n: TreeNode) => void) => {
  if (!n) return
  f(n)
  for (const c of n.children ?? []) walk(c, f)
}

try {
  await driver.waitForLauncher()
  // Paced: back-to-back starts under load are the failure this census explains.
  for (let i = 0; i < chats; i++) {
    await driver.startChat(`census ${i}`)
    await Bun.sleep(4000)
  }

  if (process.env.CENSUS_GROWTH) {
    for (let i = 0; i < Number(process.env.CENSUS_GROWTH); i++) {
      const rows = (await tree()) && 0
      await measure(`t+${(i + 1) * (windowS + 12)}s`, async (until) => {
        await Bun.sleep(until - Date.now())
        let n = 0
        walk(await tree(), (node) => {
          if (node.testId === 'chat-transcript-list') walk(node, () => n++)
        })
        const crash = await driver.crashed().catch((e) => String(e).slice(0, 120))
        let textChars = 0
        walk(await tree(), (node) => {
          if (node.type === 'markdown' || node.type === 'text')
            textChars += (node.text ?? '').length
        })
        return `${n + rows} transcript nodes, ${textChars} chars of text${crash ? ` CRASH ${crash.slice(0, 200)}` : ''}`
      })
      await Bun.sleep(12_000)
    }
    const types = new Map<string, number>()
    let rows = 0
    walk(await tree(), (node) => {
      if (node.testId !== 'chat-transcript-list') return
      rows = node.children?.length ?? 0
      walk(node, (x) => {
        const key = x.testId?.replace(/-[0-9a-f-]{8,}.*$/, '-*') ?? x.type
        types.set(key, (types.get(key) ?? 0) + 1)
      })
    })
    console.log(
      `rows ${rows}; node kinds: ${[...types]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`
    )
    throw new Error('growth done')
  }
  await measure('quiet', async (until) => {
    await Bun.sleep(until - Date.now())
    return ''
  })
  await measure('poll', async (until) => {
    const ms: number[] = []
    while (Date.now() < until) {
      const t = performance.now()
      await tree()
      ms.push(performance.now() - t)
      await Bun.sleep(250)
    }
    ms.sort((x, y) => x - y)
    return `getTree x${ms.length}, p50 ${Math.round(ms[ms.length >> 1])} ms, max ${Math.round(ms.at(-1) ?? 0)} ms`
  })
  await measure('switch', async (until) => {
    let n = 0
    while (Date.now() < until) {
      await driver.switchToChat(n++)
      await Bun.sleep(1000)
    }
    return `${n} switches`
  })
  const root = await tree()
  let composer: TreeNode | null = null
  walk(root, (n) => {
    if (n.testId === 'composer-editor' && (n.bounds?.width ?? 0) > 0) composer = n
  })
  await measure('type', async (until) => {
    if (!composer) return 'no composer on screen'
    const id = (composer as TreeNode).id
    let keys = 0
    while (Date.now() < until) {
      await handle.app.call('keystrokes', { elementId: id, keys: 'a' }).catch(() => undefined)
      keys++
      await Bun.sleep(100)
    }
    return `${keys} keys`
  })
} finally {
  await handle.close()
  await server.stop()
}
process.exit(0)
