/**
 * Design probe for the composer: which keys a stock 0.11 `<textarea>` and a
 * focusable `<div>` report to JS, and whether the live renderer's
 * `simulateKeystrokes` can place the caret after an external `value` set.
 * Driven by `probe-run.ts`; events go to `$PROBE_LOG`.
 */
import { appendFileSync } from 'node:fs'
import { render, useGpuixRequired, type KeyEvent } from '@gpuix/react'
import { useState } from 'react'

const LOG = process.env.PROBE_LOG ?? '/tmp/gpuix-o3/probe.log'
const log = (line: string) => appendFileSync(LOG, `${line}\n`)
const keyLine = (who: string, kind: string, e: KeyEvent) =>
  `${who} ${kind} key=${e.key} char=${JSON.stringify(e.keyChar ?? null)} mods=${JSON.stringify(e.modifiers ?? {})} held=${e.isHeld ?? false}`

type Simulating = { simulateKeystrokes?: (keys: string) => void }

function Probe() {
  const renderer = useGpuixRequired()
  const [value, setValue] = useState('')
  return (
    <div style={{ width: 800, height: 600, display: 'flex', flexDirection: 'column', gap: 16, padding: 20, backgroundColor: '#111' }}>
      <textarea
        testId="ta"
        value={value}
        minRows={2}
        maxRows={6}
        style={{ width: 400, color: '#eee', fontSize: 14, backgroundColor: '#222' }}
        onChange={(e) => {
          log(`ta change ${JSON.stringify(e.value)}`)
          setValue(e.value ?? '')
        }}
        onSubmit={(e) => log(`ta submit ${JSON.stringify(e.value)}`)}
        onKeyDown={(e) => {
          log(keyLine('ta', 'down', e))
          if (e.key === 'escape') {
            setValue('hello world')
            setTimeout(() => {
              const sim = (renderer as Simulating).simulateKeystrokes
              log(`ta sim available=${typeof sim}`)
              sim?.call(renderer, 'cmd-up right right')
            }, 50)
          }
        }}
        onKeyUp={(e) => log(keyLine('ta', 'up', e))}
      />
      <div
        testId="kd"
        tabIndex={0}
        style={{ width: 400, height: 60, backgroundColor: '#333' }}
        onKeyDown={(e) => log(keyLine('kd', 'down', e))}
        onKeyUp={(e) => log(keyLine('kd', 'up', e))}
      >
        <text style={{ color: '#eee' }}>key capture</text>
      </div>
    </div>
  )
}

render(<Probe />, { title: 'composer-probe', width: 800, height: 600, focus: false })
