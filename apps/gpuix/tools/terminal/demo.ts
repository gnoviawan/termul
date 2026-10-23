/**
 * Drives demo.tsx under Xvfb through `@gpuix/react/automation`: waits for
 * the shell, lets the fixture run, screenshots it, then types `echo hi` and
 * asserts a visible row reads exactly `hi`.
 *
 * bun tools/terminal/demo.ts [outDir]
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { launch } from '@gpuix/react/automation'
import { gpuixEnv, grabScreen, startXvfb } from './xvfb'

interface DemoState {
  status: string
  rows: string[]
  cursor: { x: number; y: number }
}

const readState = async (file: string): Promise<DemoState | null> =>
  existsSync(file)
    ? ((await Bun.file(file)
        .json()
        .catch(() => null)) as DemoState | null)
    : null

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
    await Bun.sleep(100)
  }
  throw new Error(
    `timed out waiting for ${what}; last state: ${JSON.stringify(await readState(file))}`
  )
}

export async function runDemo(outDir = '/tmp/gpuix-t1/demo') {
  mkdirSync(outDir, { recursive: true })
  const stateFile = resolve(outDir, 'state.json')
  if (existsSync(stateFile)) unlinkSync(stateFile)
  const xvfb = await startXvfb()
  const app = await launch({
    command: 'bun',
    args: [resolve(import.meta.dir, 'demo.tsx'), stateFile],
    env: gpuixEnv(xvfb.display)
  })
  try {
    await app.getByTestId('terminal').waitFor({ timeoutMs: 60_000 })
    const idle = await waitForState(
      stateFile,
      (state) => state.status === 'idle',
      60_000,
      'the fixture to finish'
    )
    const fixturePng = resolve(outDir, 'fixture.png')
    await grabScreen(xvfb.display, fixturePng)
    const before = idle.rows.length

    const terminal = app.getByTestId('terminal')
    await terminal.click()
    for (const key of ['e', 'c', 'h', 'o', 'space', 'h', 'i']) await terminal.press(key)
    await terminal.press('enter')
    const typed = await waitForState(
      stateFile,
      (state) => state.rows.includes('hi'),
      10_000,
      'the `hi` row'
    )
    await Bun.sleep(300)
    const typedPng = resolve(outDir, 'typed.png')
    await grabScreen(xvfb.display, typedPng)
    const hiRow = typed.rows.indexOf('hi')
    const result = {
      fixtureRows: before,
      fixtureLastRows: idle.rows.filter((row) => row.length).slice(-4),
      typedEchoRow: typed.rows[hiRow - 1],
      hiRow,
      hiRowText: typed.rows[hiRow],
      cursorAfter: typed.cursor,
      png: { fixture: fixturePng, typed: typedPng }
    }
    console.log(JSON.stringify(result, null, 2))
    if (typed.rows[hiRow] !== 'hi' || typed.rows[hiRow - 1] !== '$ echo hi') {
      console.error('TYPING CHECK FAILED')
      process.exitCode = 1
    }
    return result
  } finally {
    await app.close().catch(() => {})
    xvfb.stop()
  }
}

if (import.meta.main) {
  await runDemo(process.argv[2])
  process.exit(process.exitCode ?? 0)
}
