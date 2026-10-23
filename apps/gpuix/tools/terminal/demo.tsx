/**
 * Live terminal demo: a GPUIX window with one TerminalView attached to a
 * shell spawned on a termul-server through Termul's `/terminal/ws` client.
 * Runs the fixture script after the prompt appears, then keeps mirroring the
 * visible rows to STATE_FILE on every frame so a driver (demo.ts) can assert
 * what typed input produced.
 *
 * TERMUL_SERVER_URL=http://127.0.0.1:8191 bun tools/terminal/demo.tsx [stateFile] [--no-fixture]
 */
import { writeFileSync } from 'node:fs'
import { useEffect, useRef, useState } from 'react'
import { render } from '@gpuix/react'
import { TerminalView } from '../../src/terminal/TerminalView'
import { terminalLog } from '../../src/terminal/log'
import { TerminalScreen } from '../../src/terminal/screen'
import { terminalThemeFor } from '../../src/terminal/theme'
import { loadTerminalTransport, spawnSession, type TerminalSession } from '../../src/terminal/transport'
import { FIXTURE_COLS, FIXTURE_ROWS, FIXTURE_STEPS, PROJECT_DIR, PROJECT_ID, seedFixtureDir, SERVER_ORIGIN, SERVER_TOKEN, SHELL_SPAWN } from './fixture'
import { SCREEN } from './xvfb'

const args = process.argv.slice(2)
const stateFile = args.find((arg) => !arg.startsWith('--')) ?? '/tmp/gpuix-t1/demo-state.json'
const runFixture = !args.includes('--no-fixture')
const theme = terminalThemeFor('termul')
const screen = new TerminalScreen({ cols: FIXTURE_COLS, rows: FIXTURE_ROWS, theme })

function App() {
  const session = useRef<TerminalSession | null>(null)
  const [status, setStatus] = useState('connecting')
  useEffect(() => {
    let live = true
    const publish = () => {
      if (!live) return
      writeFileSync(stateFile, JSON.stringify({ status, rows: screen.visibleText(), cursor: screen.frame().cursor, cols: screen.cols, rows_: screen.rows }))
    }
    const offFrame = screen.onFrame(publish)
    ;(async () => {
      seedFixtureDir()
      const transport = await loadTerminalTransport({ origin: SERVER_ORIGIN, token: SERVER_TOKEN, windowSize: SCREEN })
      const spawned = await spawnSession(transport, {
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
        for (const step of FIXTURE_STEPS) {
          spawned.write(step.input.endsWith('\r') ? step.input : `${step.input}\r`)
          await Bun.sleep(step.waitMs)
        }
      }
      await Bun.sleep(300)
      setStatus('idle')
      publish()
    })().catch((error) => {
      terminalLog('error', 'demo.failed', { error: String(error) })
      setStatus(`error: ${String(error)}`)
    })
    return () => {
      live = false
      offFrame()
      session.current?.dispose()
    }
  }, [])
  useEffect(() => {
    writeFileSync(stateFile, JSON.stringify({ status, rows: screen.visibleText(), cursor: screen.frame().cursor, cols: screen.cols, rows_: screen.rows }))
  }, [status])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: theme.background }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 12, backgroundColor: '#111214' }}>
        <text testId="demo-status" style={{ color: '#9a9b9d', fontSize: 12 }}>{`termul gpuix terminal · ${SERVER_ORIGIN} · ${status}`}</text>
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

render(<App />, { title: 'Termul terminal (GPUIX)', width: SCREEN.width, height: SCREEN.height, focus: process.env.GPUIX_BACKGROUND !== '1' })
