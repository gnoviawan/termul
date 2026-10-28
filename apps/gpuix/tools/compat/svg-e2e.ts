/**
 * The depth bomb end to end in the real GPUIX client, by the two routes a user
 * meets a hostile SVG:
 *
 *   icon   a custom agent whose stored icon is the bomb, saved to the server's
 *          `agents/custom` key as a web client would save it; Settings > Agent
 *          chats paints its tile.
 *   chat   an agent reply whose markdown embeds the bomb as `data:` and
 *          `http:` images; the chat paints them through native `<img>`.
 *
 *   budget the same reply also embeds the decode bombs of `image-attacks.ts`
 *          (svgz, PNG, GIF) and the SVGs that burned the decoder before
 *          zed/0011 (mask fan-out, a 100000-unit viewBox, 100000 turbulence
 *          octaves, 60000 glyphs, a filter region far past the canvas). From
 *          the click that opens the chat until BUDGET_WINDOW_MS later, the
 *          client may spend at most BUDGET_CPU_MS of CPU and grow its resident
 *          memory by at most BUDGET_RSS_MB.
 *
 * Both routes run in one client against a fresh test server. The client must
 * still answer automation after each, and a benign green image in the same
 * reply must paint. The addon under test is whatever
 * NAPI_RS_NATIVE_LIBRARY_PATH names (the published addon when unset).
 *
 * bun tools/compat/svg-e2e.ts [--state DIR] [--out DIR]
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'
import { scopedKey } from '../../../../src/shared/types/persistence.types.ts'
import { buildClient } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { sendPrompt } from '../chat/seed'
import { gpuixDriver } from '../matrix/drive'
import { addProject, startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { pickPort, registerAgent } from '../shared/seed'
import { commandId, connectWs } from '../shared/ws'
import { IMAGE_ATTACKS } from './image-attacks'
import { ATTACK_STATE } from './svg-attack-shared'
import { SVG_ATTACKS } from './svg-attacks'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    state: { type: 'string', default: path.join(ATTACK_STATE, 'e2e') },
    out: { type: 'string', default: path.join(ATTACK_STATE, 'e2e-out') }
  }
})
const state = path.resolve(values.state as string)
const out = path.resolve(values.out as string)
rmSync(state, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const TOKEN = 'gpuix-svg-e2e'
const DEVICE = 'svg-e2e'
const PROMPT = 'Show the hostile SVG images'
const DONE = 'SVG_E2E_DONE'
const ICON_AGENT = 'Depth Bomb Agent'
const NS = 'xmlns="http://www.w3.org/2000/svg"'
const nest = (depth: number, leaf: string) => `${'<g>'.repeat(depth)}${leaf}${'</g>'.repeat(depth)}`
/** The review's payload: 24.6 KB, under the 64 KB upload and paste caps. */
const BOMB = `<svg ${NS} viewBox="0 0 1 1">${nest(3500, '<path fill="#000" d="M0 0h1v1z"/>')}</svg>`
const MONO_BOMB = `<svg ${NS} viewBox="0 0 1 1">${nest(14000, '<path d="M0 0h1v1z"/>')}</svg>`
const GREEN = `<svg ${NS} width="64" height="64"><rect width="64" height="64" fill="#00ff00"/></svg>`
const dataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const BUDGET_SVGS = [
  'mask-fan-out',
  'huge-viewbox-colour',
  'fe-turbulence',
  'text-flood',
  'fe-gaussian-blur'
]
const BUDGET_WINDOW_MS = 12_000
/** Everything the chat does in the window, the transcript's own render included. */
const BUDGET_CPU_MS = 6000
const BUDGET_RSS_MB = 192
const budgetImages = [
  ...(await Promise.all(
    IMAGE_ATTACKS.filter((attack) => !attack.id.startsWith('control-')).map(
      async (attack) =>
        `![${attack.id}](data:${attack.mime};base64,${(await attack.bytes()).toString('base64')})`
    )
  )),
  ...BUDGET_SVGS.map((id) => {
    const attack = SVG_ATTACKS.find((a) => a.id === id)
    if (!attack) throw new Error(`no SVG attack ${id}`)
    return `![${id}](${dataUrl(attack.markup)})`
  })
]

/** The pid whose environment names `marker`: the client, found by its data dir. */
function pidWithEnv(marker: string): number | null {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/environ`, 'latin1').split('\0').includes(marker))
        return Number(entry)
    } catch {}
  }
  return null
}
const cpuMsOf = (pid: number) => {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? []
  return (Number(fields[11]) + Number(fields[12])) * 10
}
const rssMbOf = (pid: number) =>
  (Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096) / 2 ** 20

const images = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (req) =>
    new Response(new URL(req.url).pathname === '/bomb.svg' ? BOMB : GREEN, {
      headers: { 'content-type': 'image/svg+xml' }
    })
})
const replyFile = path.join(state, 'reply.md')
mkdirSync(state, { recursive: true })
writeFileSync(
  replyFile,
  [
    'Depth bombs as data URLs:',
    `![bomb](${dataUrl(BOMB)})`,
    `![mono-bomb](${dataUrl(MONO_BOMB)})`,
    'Depth bomb over http:',
    `![remote-bomb](http://127.0.0.1:${images.port}/bomb.svg)`,
    'Decode bombs, each bounded by the native budget:',
    ...budgetImages,
    'Benign images over http and as a data URL, which must still paint:',
    `![remote-green](http://127.0.0.1:${images.port}/green.svg)`,
    `![green](${dataUrl(GREEN)})`,
    DONE
  ].join('\n\n')
)

const port = await pickPort()
const server = await startTestServer({ port, token: TOKEN, stateDir: path.join(state, 'server') })
const failures: string[] = []
try {
  const projectDir = path.join(state, 'project')
  await addProject(server, { id: 's2-e2e', name: 's2-e2e', path: projectDir, color: 'blue' })
  const ws = await connectWs({
    baseUrl: server.baseUrl,
    token: TOKEN,
    deviceId: DEVICE,
    clientInstanceId: `${DEVICE}-seed`
  })
  await ws.request('set_default_project', { projectId: 's2-e2e' })
  const agent = {
    configId: 'svg-e2e-agent',
    name: 'SVG E2E Agent',
    command: 'bun',
    args: [path.join(import.meta.dir, 'svg-e2e-agent.ts')],
    env: { SVG_E2E_REPLY_FILE: replyFile },
    allowTerminal: false
  }
  await registerAgent(ws, DEVICE, agent)
  const acpKey = scopedKey('acp/agents', DEVICE)
  const acp = await ws.request<{ revision?: number }>('store_read', { key: acpKey })
  await ws.request('store_write', {
    key: acpKey,
    value: {
      _version: 1,
      data: [
        { id: agent.configId, ...agent, icon: MONO_BOMB },
        { ...agent, id: 'svg-e2e-icon', configId: 'svg-e2e-icon', name: ICON_AGENT, icon: BOMB }
      ]
    },
    baseRevision: acp.revision ?? 0
  })
  const { agentId } = await ws.request<{ agentId: string }>(
    'spawn_agent',
    { config: agent, projectId: 's2-e2e' },
    { commandId: commandId('spawn') }
  )
  const { sessionId } = await ws.request<{ sessionId: string }>(
    'create_session',
    { agentId, cwd: projectDir, projectId: 's2-e2e' },
    { commandId: commandId('session') }
  )
  await sendPrompt(ws, { agentId, sessionId }, PROMPT)
  const customKey = 'shared/lww/agents/custom'
  const current = await ws.request<{ revision?: number }>('store_read', { key: customKey })
  await ws.request('store_write', {
    key: customKey,
    value: {
      _version: 1,
      data: {
        agents: [
          {
            id: 'custom-depth-bomb',
            name: 'Depth Bomb Terminal Agent',
            command: 'true',
            baseArgs: [],
            promptMode: 'none',
            icon: BOMB,
            isBuiltIn: false
          },
          {
            id: 'custom-mono-bomb',
            name: 'Mono Bomb Agent',
            command: 'true',
            baseArgs: [],
            promptMode: 'none',
            icon: MONO_BOMB,
            isBuiltIn: false
          }
        ]
      }
    },
    baseRevision: current.revision ?? 0
  })
  ws.close()

  const clientStateDir = path.join(state, 'client')
  const host = new URL(server.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
  mkdirSync(path.join(clientStateDir, 'web-storage'), { recursive: true })
  writeFileSync(
    path.join(clientStateDir, 'web-storage', `${host}.json`),
    JSON.stringify({ 'termul.deviceId': DEVICE })
  )
  const build = await buildClient()
  console.log(`addon: ${process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? '@gpuix/native (published)'}`)
  await withGpuix(
    {
      server,
      entry: build.entry,
      clientStateDir,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      env: { TERMUL_GPUIX_DATA_DIR: path.join(state, 'data') }
    },
    async ({ app, grab }) => {
      const drive = gpuixDriver(app, new Map())
      const act = async (step: string, text: string) => {
        const log = await drive.act(step, 0, { do: 'click', target: { text, exact: false } })
        if (!log.ok) throw new Error(`${step}: ${log.error ?? 'click failed'}`)
      }
      const alive = async (what: string, text: string) => {
        const started = performance.now()
        try {
          // A dead client never answers: automation's requests stay pending rather than reject.
          await Promise.race([
            app.getByText(text).waitFor({ timeoutMs: 15_000 }),
            Bun.sleep(20_000).then(() => {
              throw new Error('no answer from the client in 20 s')
            })
          ])
          console.log(
            `${what}: client alive, "${text}" on screen (${Math.round(performance.now() - started)} ms)`
          )
        } catch (error) {
          failures.push(
            `${what}: client gone or "${text}" never painted (${String(error).slice(0, 200)})`
          )
          throw error
        }
      }

      await app.getByText(PROMPT).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const pid = pidWithEnv(`TERMUL_GPUIX_DATA_DIR=${path.join(state, 'data')}`)
      if (!pid) throw new Error('no client process carries this run\'s data dir')
      const cpuBefore = cpuMsOf(pid)
      const rssBefore = rssMbOf(pid)
      let rssPeak = rssBefore
      const sampler = setInterval(() => {
        try {
          rssPeak = Math.max(rssPeak, rssMbOf(pid))
        } catch {}
      }, 50)
      const windowEnds = Bun.sleep(BUDGET_WINDOW_MS)
      await act('chat', PROMPT)
      await alive('chat', DONE)
      await windowEnds
      clearInterval(sampler)
      const cpuSpent = cpuMsOf(pid) - cpuBefore
      const rssGrowth = rssPeak - rssBefore
      console.log(
        `budget: ${budgetImages.length} bombs, client CPU ${cpuSpent} ms and resident memory +${rssGrowth.toFixed(0)} MB over ${BUDGET_WINDOW_MS} ms`
      )
      if (cpuSpent > BUDGET_CPU_MS)
        failures.push(`budget: the client spent ${cpuSpent} ms CPU (budget ${BUDGET_CPU_MS})`)
      if (rssGrowth > BUDGET_RSS_MB)
        failures.push(
          `budget: resident memory grew ${rssGrowth.toFixed(0)} MB (budget ${BUDGET_RSS_MB})`
        )
      await alive('chat after the image decodes', DONE)
      const chatShot = path.join(out, 'chat.png')
      await grab(chatShot)
      const png = PNG.sync.read(readFileSync(chatShot))
      let green = 0
      for (let i = 0; i < png.data.length; i += 4)
        if (png.data[i + 1]! > 200 && png.data[i]! < 60 && png.data[i + 2]! < 60) green++
      console.log(`chat: ${chatShot} green pixels ${green}`)
      if (green < 64 * 64 * 0.5) failures.push(`chat: the benign green image painted ${green} px`)

      await app.call('keystrokes', { keys: 'ctrl-,' })
      await alive('settings', 'Interface zoom')
      await act('agents', 'Agent chats')
      await alive('agents', ICON_AGENT)
      // The filter input has no text or test id to find it by; the check below fails if this misses it.
      await drive.act('filter', 0, { do: 'click', target: { point: { x: 760, y: 654 } } })
      await drive.act('filter', 1, { do: 'type', text: 'bomb' })
      await alive('agents filtered to the bomb', ICON_AGENT)
      if ((await app.getByText('Agoragentic').count()) > 0)
        failures.push('agents: the filter did not narrow the list to the bomb agent')
      await Bun.sleep(3000)
      await alive('agents after the icon paints', ICON_AGENT)
      await grab(path.join(out, 'agents.png'))
      console.log(`agents: ${path.join(out, 'agents.png')}`)
    }
  )
} catch (error) {
  if (!failures.length) failures.push(String(error))
} finally {
  await server.stop()
  images.stop(true)
}

if (failures.length) {
  console.error(`FAIL ${failures.length}:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('PASS')
