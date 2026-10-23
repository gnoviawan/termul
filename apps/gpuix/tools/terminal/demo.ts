/**
 * End-to-end terminal demo against a seeded throwaway termul-server (P0's
 * `startTestServer`, first free port in 8190-8199). With `--record` it first
 * records the fixture into `fixtures/`. Then it runs demo.tsx under Xvfb
 * through `@gpuix/react/automation`, shoots the alt-screen programs and the
 * finished fixture, types `echo hi` + Enter and asserts the output row reads
 * exactly `hi`.
 *
 * bun tools/terminal/demo.ts [--out DIR] [--record]
 */
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { addProject, startTestServer } from '../parity/server'
import { withGpuix } from '../parity/shoot-gpuix'
import { terminalEntry } from './bundle'
import type { DemoState } from './demo.tsx'
import { FIXTURE_BYTES, FIXTURE_CHECKPOINTS, PROJECT_DIR, PROJECT_ID } from './fixture'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-t1/demo' },
    record: { type: 'boolean', default: false }
  }
})
const outDir = values.out
mkdirSync(outDir, { recursive: true })

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function freePort(): Promise<number> {
  for (let port = 8190; port <= 8199; port++) if (await portIsFree(port)) return port
  throw new Error('no free port in 8190-8199')
}

async function readState(file: string): Promise<DemoState | null> {
  if (!existsSync(file)) return null
  return (await Bun.file(file)
    .json()
    .catch(() => null)) as DemoState | null
}

async function waitForState(
  file: string,
  predicate: (state: DemoState) => boolean,
  timeoutMs: number,
  what: string
): Promise<DemoState> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await readState(file)
    if (state && predicate(state)) return state
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(await readState(file))}`)
}

const port = await freePort()
const server = await startTestServer({
  port,
  token: 'terminal-demo-token',
  stateDir: '/tmp/gpuix-t1/server'
})
const clientEnv = {
  TERMUL_SERVER_URL: server.baseUrl,
  TERMUL_SERVER_TOKEN: server.token,
  TERMUL_GPUIX_STATE_DIR: '/tmp/gpuix-t1/client'
}
try {
  await addProject(server, { id: PROJECT_ID, name: 'terminal', path: PROJECT_DIR, color: 'blue' })
  if (values.record) {
    const recorder = Bun.spawn(
      ['bun', await terminalEntry('record'), FIXTURE_BYTES, FIXTURE_CHECKPOINTS],
      {
        env: { ...process.env, ...clientEnv },
        stdout: 'inherit',
        stderr: 'inherit'
      }
    )
    if ((await recorder.exited) !== 0) throw new Error('fixture recording failed')
  }

  const stateFile = path.join(outDir, 'state.json')
  // withGpuix passes this process's env to `bun <entry>`, with no arguments.
  process.env.TERMUL_DEMO_STATE_FILE = stateFile
  const result = await withGpuix(
    {
      server,
      entry: await terminalEntry('demo'),
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      clientStateDir: clientEnv.TERMUL_GPUIX_STATE_DIR
    },
    async ({ app, grab }) => {
      await app.getByTestId('terminal').waitFor({ timeoutMs: 60_000 })
      const shots: Record<string, string> = {}
      const rows: Record<string, string[]> = {}
      for (const step of ['less', 'vim']) {
        await waitForState(stateFile, (s) => s.step === step, 60_000, step)
        await Bun.sleep(1200)
        shots[step] = path.join(outDir, `${step}.png`)
        await grab(shots[step])
        const state = await waitForState(stateFile, () => true, 1000, 'state')
        rows[step] = state.rows.filter((row) => row.length).slice(0, 4)
      }
      const idle = await waitForState(stateFile, (s) => s.status === 'idle', 60_000, 'idle')
      shots.fixture = path.join(outDir, 'fixture.png')
      await grab(shots.fixture)

      const terminal = app.getByTestId('terminal')
      await terminal.click()
      for (const key of ['e', 'c', 'h', 'o', 'space', 'h', 'i']) await terminal.press(key)
      await terminal.press('enter')
      const typed = await waitForState(stateFile, (s) => s.rows.includes('hi'), 10_000, '`hi`')
      shots.typed = path.join(outDir, 'typed.png')
      await grab(shots.typed)
      const hiRow = typed.rows.indexOf('hi')
      return {
        server: server.baseUrl,
        grid: [idle.cols, idle.rowCount],
        altScreenRows: rows,
        fixtureLastRows: idle.rows.filter((row) => row.length).slice(-3),
        echoRow: typed.rows[hiRow - 1],
        hiRowText: typed.rows[hiRow],
        typingOk: typed.rows[hiRow] === 'hi' && typed.rows[hiRow - 1] === '$ echo hi',
        png: shots
      }
    }
  )
  console.log(JSON.stringify(result, null, 2))
  if (!result.typingOk) {
    console.error('TYPING CHECK FAILED')
    process.exitCode = 1
  }
} finally {
  await server.stop()
}
process.exit(process.exitCode ?? 0)
