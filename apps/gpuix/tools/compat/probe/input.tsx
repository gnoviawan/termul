/** Probe: which of keyDown and submit a stock `<input>` reports for Enter and the arrows. Events go to `$PROBE_LOG`. */
import { appendFileSync } from 'node:fs'
import { render } from '@gpuix/react'

const LOG = process.env.PROBE_LOG ?? '/tmp/gpuix-g1/input-probe.log'
const log = (line: string) => appendFileSync(LOG, `${line}\n`)

render(
  <div
    style={{ width: 600, height: 300, padding: 20, backgroundColor: '#111' }}
    onKeyDown={(e) => log(`parent down ${e.key}`)}
  >
    <input
      testId="in"
      style={{ width: 300, height: 28, color: '#eee', backgroundColor: '#222' }}
      onKeyDown={(e) => log(`in down ${e.key}`)}
      onSubmit={(e) => log(`in submit ${JSON.stringify(e.value)}`)}
      onChange={(e) => log(`in change ${JSON.stringify(e.value)}`)}
    />
  </div>,
  { title: 'input probe', width: 640, height: 340 }
)
