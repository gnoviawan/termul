/**
 * Live terminal demo: a GPUIX window with one TerminalView attached to a
 * shell spawned on the termul-server named by `TERMUL_SERVER_URL`, through
 * Termul's `/terminal/ws` client. Runs the fixture steps after the prompt
 * appears and mirrors the visible rows and the current step to the state
 * file on every frame, so `demo.ts` can shoot and assert what it sees.
 *
 * TERMUL_DEMO_STATE_FILE=<state.json> bun dist/terminal/demo.js [--no-fixture]
 */
import { renameSync, writeFileSync } from 'node:fs'
import { render } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { readClientConfig } from '../../src/env/config'
import { log } from '../../src/log'
import { TerminalScreen } from '../../src/terminal/screen'
import { TerminalView } from '../../src/terminal/TerminalView'
import { terminalThemeFor } from '../../src/terminal/theme'
import { loadTerminalApi, spawnSession, type TerminalSession } from '../../src/terminal/transport'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import {
  FIXTURE_COLS,
  FIXTURE_ROWS,
  FIXTURE_STEPS,
  PROJECT_DIR,
  PROJECT_ID,
  SHELL_SPAWN,
  seedFixtureDir
} from './fixture'

export interface DemoState {
  status: string
  step: string | null
  rows: string[]
  cursor: { x: number; y: number }
  cols: number
  rowCount: number
}

const args = process.argv.slice(2)
const stateFile = process.env.TERMUL_DEMO_STATE_FILE ?? ''
if (!stateFile) throw new Error('TERMUL_DEMO_STATE_FILE is not set')
const runFixture = !args.includes('--no-fixture')
const config = readClientConfig()
const theme = terminalThemeFor('termul')
const screen = new TerminalScreen({ cols: FIXTURE_COLS, rows: FIXTURE_ROWS, theme })

let status = 'connecting'
let step: string | null = null

function publish(): void {
  const frame = screen.frame()
  const state: DemoState = {
    status,
    step,
    rows: screen.visibleText(),
    cursor: { x: frame.cursor.x, y: frame.cursor.y },
    cols: screen.cols,
    rowCount: screen.rows
  }
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(state))
  renameSync(`${stateFile}.tmp`, stateFile)
}

function App() {
  const session = useRef<TerminalSession | null>(null)
  const [label, setLabel] = useState(status)
  useEffect(() => {
    let live = true
    const setStatus = (next: string) => {
      status = next
      setLabel(next)
      publish()
    }
    const offFrame = screen.onFrame(publish)
    ;(async () => {
      seedFixtureDir()
      const api = await loadTerminalApi(config)
      const spawned = await spawnSession(api, {
        ...SHELL_SPAWN,
        projectId: PROJECT_ID,
        cwd: PROJECT_DIR,
        cols: screen.cols,
        rows: screen.rows,
        onData: (bytes) => screen.write(bytes),
        onExit: (code) => {
          screen.write(`\r\n\x1b[2m[process exited with ${code}]\x1b[0m\r\n`)
          setStatus('exited')
        }
      })
      if (!live) return
      session.current = spawned
      spawned.resize(screen.cols, screen.rows)
      setStatus('ready')
      if (runFixture) {
        await Bun.sleep(500)
        for (const next of FIXTURE_STEPS) {
          step = next.name
          spawned.write(next.input.endsWith('\r') ? next.input : `${next.input}\r`)
          await Bun.sleep(next.waitMs)
          publish()
        }
      }
      step = null
      await Bun.sleep(300)
      setStatus('idle')
    })().catch((error) => {
      log.error('terminal', `demo.failed ${JSON.stringify({ error: String(error) })}`)
      setStatus(`error: ${String(error)}`)
    })
    return () => {
      live = false
      offFrame()
      session.current?.dispose()
    }
  }, [])
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: theme.background
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 28,
          paddingLeft: 12,
          backgroundColor: theme.background
        }}
      >
        <text testId="demo-status" style={{ color: theme.brightBlack, fontSize: 12 }}>
          {`termul gpuix terminal · ${config.serverUrl.origin} · ${label}`}
        </text>
      </div>
      <TerminalView
        screen={screen}
        onInput={(data) => session.current?.write(data)}
        onResize={(cols, rows) => session.current?.resize(cols, rows)}
        cursorBlink={false}
        padding={8}
        testId="terminal"
      />
    </div>
  )
}

render(<App />, {
  title: 'Termul terminal (GPUIX)',
  width: WINDOW_WIDTH,
  height: WINDOW_HEIGHT,
  focus: process.env.GPUIX_BACKGROUND !== '1'
})
