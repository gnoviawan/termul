/**
 * `bun tools/chat/live.ts [--state DIR] [--port N]`
 *
 * A long-lived GPUIX session against the matrix world, for reproducing a gap
 * and checking a fix without reseeding: it seeds `tools/matrix/world.ts`
 * once, boots the client under Xvfb and then takes commands over HTTP on a
 * local port (written to `<state>/live.port`). `reload` rebuilds and relaunches
 * the client against the same world, so an edit is one request away.
 *
 *   curl -s localhost:$(cat /tmp/gpuix-g2/live/live.port) -d '{"do":"click","text":"How does"}'
 *
 * Commands: click {text|testId|x,y, button?}, wheel {text|testId|x,y, dy},
 * move {x,y}, keys {keys}, type {text}, shot {file}, text {}, tree {testId?},
 * bounds {testId|text}, wait {ms}, reload {}, stop {}.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { gpuiKeystrokes } from '../matrix/drive'
import { createWorld, prepareDevice, setTheme } from '../matrix/world'
import { withGpuix } from '../parity/shoot-gpuix'
import { pickPort } from '../shared/seed'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    state: { type: 'string', default: '/tmp/gpuix-g2/live' },
    port: { type: 'string' }
  }
})

const STATE = path.resolve(values.state as string)
type Session = Parameters<Parameters<typeof withGpuix>[1]>[0]
type Command = Record<string, unknown> & { do: string }

mkdirSync(STATE, { recursive: true })
const world = await createWorld({
  port: await pickPort(values.port ? Number(values.port) : undefined),
  root: path.join(STATE, 'world')
})
console.error(`[live] world on ${world.server.baseUrl}`)

let current: { session: Session; done: () => void } | null = null
let generation = 0

async function boot(): Promise<void> {
  const build = await buildClient()
  if (!build.ok) throw new Error(build.logs.join('\n'))
  generation += 1
  const deviceId = `g2-live-${generation}`
  await prepareDevice(world, deviceId)
  await setTheme(world, 'termul', 'dark')
  const clientStateDir = path.join(STATE, 'clients', String(generation))
  const host = new URL(world.server.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
  mkdirSync(path.join(clientStateDir, 'web-storage'), { recursive: true })
  writeFileSync(
    path.join(clientStateDir, 'web-storage', `${host}.json`),
    JSON.stringify({ 'termul.deviceId': deviceId })
  )
  await new Promise<void>((ready, failed) => {
    withGpuix(
      {
        server: world.server,
        entry: build.entry,
        clientStateDir,
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT
      },
      async (session) => {
        await session.app.getByText('What should we do in alpha?').waitFor({ timeoutMs: 60_000 })
        await new Promise<void>((done) => {
          current = { session, done }
          ready()
        })
      }
    ).catch(failed)
  })
}

async function point(app: Session['app'], cmd: Command): Promise<{ x: number; y: number }> {
  if (typeof cmd.x === 'number' && typeof cmd.y === 'number') return { x: cmd.x, y: cmd.y }
  const locator =
    typeof cmd.testId === 'string' ? app.getByTestId(cmd.testId) : app.getByText(String(cmd.text))
  return locator.center()
}

async function run(cmd: Command): Promise<unknown> {
  if (cmd.do === 'reload') {
    current?.done()
    current = null
    await Bun.sleep(500)
    await boot()
    return { generation }
  }
  if (!current) throw new Error('no client running')
  const { app, grab } = current.session
  switch (cmd.do) {
    case 'click': {
      const at = await point(app, cmd)
      await app.call('click', { ...at, button: cmd.button === 'right' ? 2 : 0 })
      return at
    }
    case 'wheel': {
      const at = await point(app, cmd)
      await app.mouse.wheel(at, 0, Number(cmd.dy))
      return at
    }
    case 'move':
      await app.mouse.move({ x: Number(cmd.x), y: Number(cmd.y) })
      return null
    case 'keys':
      await app.call('keystrokes', { keys: String(cmd.keys) })
      return null
    case 'type':
      await app.call('keystrokes', { keys: gpuiKeystrokes(String(cmd.text)) })
      return null
    case 'shot': {
      const file = path.resolve(String(cmd.file ?? path.join(STATE, 'shot.png')))
      await grab(file)
      return file
    }
    case 'text':
      return (await app.call('getAllText', {})).text
    case 'tree':
      return typeof cmd.testId === 'string'
        ? app.getByTestId(cmd.testId).element()
        : app.call('getTree', {})
    case 'bounds':
      return typeof cmd.testId === 'string'
        ? app.getByTestId(cmd.testId).bounds()
        : app.getByText(String(cmd.text)).bounds()
    case 'wait':
      await Bun.sleep(Number(cmd.ms ?? 500))
      return null
    case 'stop':
      setTimeout(async () => {
        current?.done()
        await Bun.sleep(500)
        world.ws.close()
        await world.server.stop()
        process.exit(0)
      }, 50)
      return null
  }
  throw new Error(`unknown command ${cmd.do}`)
}

await boot()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    try {
      const result = await run((await request.json()) as Command)
      return Response.json({ ok: true, result })
    } catch (error) {
      return Response.json({ ok: false, error: String(error) }, { status: 500 })
    }
  }
})
writeFileSync(path.join(STATE, 'live.port'), String(server.port))
console.error(`[live] commands on 127.0.0.1:${server.port}`)
