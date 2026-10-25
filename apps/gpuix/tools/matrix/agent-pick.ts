/**
 * `bun tools/matrix/agent-pick.ts [--client web,gpuix] [--rounds N] [--modes send,hold] [--hold-ms N] [--port N] [--state DIR]`
 *
 * The launcher must start a chat with the device's picked agent even when the
 * prompt is typed and sent the moment the composer appears, before the
 * launcher has finished restoring that pick. Each round boots a fresh device
 * whose last-selected agent is the matrix's scripted agent, types a unique
 * prompt into the first composer it can reach, presses Enter, and reads the
 * agent of the chat the server persisted for that prompt.
 *
 * A `send` round presses Enter right after typing. A `hold` round waits
 * `--hold-ms` first, past the boot's first project commit, and requires the
 * composer to still hold the typed prompt: a launcher remounted at boot drops
 * it (G10 BOOT-REMOUNT).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Page } from 'playwright'
import { scopedKey } from '../../../../src/shared/types/persistence.types.ts'
import { buildClient } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { DIST_WEB } from '../parity/shoot-web'
import { pickPort } from '../shared/seed'
import { connectWs } from '../shared/ws'
import { createWorld, prepareDevice, TOKEN, type World } from './world'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    client: { type: 'string', default: 'web,gpuix' },
    rounds: { type: 'string', default: '3' },
    modes: { type: 'string', default: 'send,hold' },
    'hold-ms': { type: 'string', default: '3000' },
    port: { type: 'string' },
    state: { type: 'string', default: '/tmp/gpuix-g8/agent-pick' }
  }
})

const SIZE = { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
const SESSION_TIMEOUT_MS = 20_000
const HOLD_MS = Number(values['hold-ms'])

type Mode = 'send' | 'hold'
// The GPUIX composer mirrors its text into the automation tree under test hooks.
process.env.TERMUL_GPUIX_TEST_HOOKS = '1'

interface PersistedSession {
  sessionId: string
  title: string | null
  stableAgentNamespace: string
  createdAt: number
}

interface Typed {
  /** ms from the composer first being reachable to Enter. */
  typedAfterMs: number
  /** The composer's text just before Enter. */
  composerText: string
  /** The composer typed into is still the one on screen just before Enter (no remount). */
  sameComposer: boolean
}

interface Round extends Typed {
  client: 'web' | 'gpuix'
  mode: Mode
  prompt: string
  /** The persisted chat's agent namespace, or null when no chat for the prompt appeared. */
  namespace: string | null
}

async function sessionFor(world: World, prompt: string): Promise<PersistedSession | null> {
  const deadline = Date.now() + SESSION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const rows = await world.ws.request<PersistedSession[]>('list_persisted_sessions', {})
    const match = rows.find((row) => row.title?.startsWith(prompt))
    if (match) return match
    await Bun.sleep(250)
  }
  return null
}

async function webRound(
  world: World,
  deviceId: string,
  prompt: string,
  mode: Mode
): Promise<Typed> {
  const browser = await chromium.launch({
    args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks']
  })
  try {
    const context = await browser.newContext({
      viewport: SIZE,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    })
    await context.route(`${world.server.baseUrl}/**`, async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const file = path.join(DIST_WEB, url.pathname === '/' ? 'index.html' : url.pathname)
      if (request.method() === 'GET' && file.startsWith(DIST_WEB) && existsSync(file))
        return route.fulfill({ path: file })
      return route.continue()
    })
    await context.addInitScript(
      ({ token, deviceId }) => {
        localStorage.setItem('termul.webAuthToken', token)
        localStorage.setItem('termul.deviceId', deviceId)
      },
      { token: TOKEN, deviceId }
    )
    const page: Page = await context.newPage()
    await page.goto(`${world.server.baseUrl}/`)
    const editor = page.locator('[data-composer-editor="true"]').filter({ visible: true }).first()
    await editor.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS })
    const reachable = performance.now()
    await editor.evaluate((node) => {
      ;(node as { agentPickTyped?: boolean }).agentPickTyped = true
    })
    await editor.click()
    await page.keyboard.type(prompt)
    if (mode === 'hold') await Bun.sleep(HOLD_MS)
    const composerText = ((await editor.textContent()) ?? '').trim()
    const sameComposer = await page.evaluate(() =>
      [...document.querySelectorAll('[data-composer-editor="true"]')].some(
        (node) => (node as { agentPickTyped?: boolean }).agentPickTyped === true
      )
    )
    await page.keyboard.press('Enter')
    const typedAfterMs = performance.now() - reachable
    if (!(await sessionFor(world, prompt)))
      await page.screenshot({ path: path.join(root, `${deviceId}.png`) })
    await context.close()
    return { typedAfterMs, composerText, sameComposer }
  } finally {
    await browser.close()
  }
}

async function gpuixRound(
  entry: string,
  world: World,
  deviceId: string,
  prompt: string,
  mode: Mode
): Promise<Typed> {
  const clientStateDir = path.join(values.state as string, 'clients', deviceId)
  await rm(clientStateDir, { recursive: true, force: true })
  const host = new URL(world.server.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
  mkdirSync(path.join(clientStateDir, 'web-storage'), { recursive: true })
  writeFileSync(
    path.join(clientStateDir, 'web-storage', `${host}.json`),
    JSON.stringify({ 'termul.deviceId': deviceId })
  )
  return withGpuix(
    { server: world.server, entry, clientStateDir, ...SIZE },
    async ({ app, grab }) => {
      const typedInto = await app
        .getByTestId('composer-editor')
        .waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const reachable = performance.now()
      await app.getByTestId('composer-editor').click()
      await app.call('keystrokes', {
        keys: [...prompt].map((c) => (c === ' ' ? 'space' : c)).join(' ')
      })
      if (mode === 'hold') await Bun.sleep(HOLD_MS)
      const state = JSON.parse(await app.getByTestId('composer-editor-state').textContent()) as {
        text: string
      }
      const sameComposer = (await app.getByTestId('composer-editor').element()).id === typedInto.id
      await app.call('keystrokes', { keys: 'enter' })
      const typedAfterMs = performance.now() - reachable
      if (!(await sessionFor(world, prompt))) await grab(path.join(root, `${deviceId}.png`))
      return { typedAfterMs, composerText: state.text.trim(), sameComposer }
    }
  )
}

const clients = (values.client as string).split(',') as Round['client'][]
const modes = (values.modes as string).split(',') as Mode[]
const rounds = Number(values.rounds)
const root = values.state as string
await rm(root, { recursive: true, force: true })
let entry = ''
if (clients.includes('gpuix')) {
  const build = await buildClient()
  if (!build.ok) {
    for (const line of build.logs) console.error(line)
    process.exit(1)
  }
  entry = build.entry
}
const world = await createWorld({
  port: await pickPort(values.port ? Number(values.port) : undefined),
  root: path.join(root, 'world')
})
const expected = `config:${world.agent.configId}`
const results: Round[] = []
const passed = (round: Round) =>
  round.namespace === expected &&
  round.composerText === round.prompt &&
  (round.mode === 'send' || round.sameComposer)
try {
  for (const client of clients) {
    for (const mode of modes) {
      for (let n = 0; n < rounds; n++) {
        const deviceId = `pick-${client}-${mode}-${n}`
        const prompt = `agentpick ${client} ${mode} ${n}`
        await prepareDevice(world, deviceId)
        const typed =
          client === 'web'
            ? await webRound(world, deviceId, prompt, mode)
            : await gpuixRound(entry, world, deviceId, prompt, mode)
        const session = await sessionFor(world, prompt)
        const round = {
          client,
          mode,
          prompt,
          namespace: session?.stableAgentNamespace ?? null,
          ...typed
        }
        results.push(round)
        if (round.namespace !== expected) {
          const agents = await world.ws.request<{ name: string; namespace: string }[]>(
            'list_agents',
            {}
          )
          console.log(
            `     live agents: ${agents.map((a) => `${a.name} (${a.namespace})`).join(', ')}`
          )
          const ws = await connectWs({
            baseUrl: world.server.baseUrl,
            token: TOKEN,
            deviceId,
            clientInstanceId: `${deviceId}-check`
          })
          const pick = await ws.request('store_read', {
            key: scopedKey('agents/last-selected', deviceId)
          })
          ws.close()
          console.log(`     device last-selected after the round: ${JSON.stringify(pick)}`)
        }
        console.log(
          `${passed(round) ? 'ok  ' : 'FAIL'} ${client} ${mode} round ${n}: sent ${Math.round(round.typedAfterMs)} ms after the composer appeared; ${round.sameComposer ? 'same composer' : 'composer REMOUNTED'} holding ${JSON.stringify(round.composerText)}; chat agent ${round.namespace ?? '(no chat)'}`
        )
      }
    }
  }
} finally {
  await world.server.stop()
}
const failed = results.filter((round) => !passed(round))
console.log(
  `${results.length - failed.length}/${results.length} rounds kept the typed prompt and started on ${expected}`
)
process.exit(failed.length > 0 ? 1 : 0)
