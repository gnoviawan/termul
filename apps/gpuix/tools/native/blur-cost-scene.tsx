/**
 * The window `blur-cost.ts` times: a 1280x800 page of text under a full-window
 * scrim, `bg-overlay/60` with `backdropBlur: <sigma>` (0: no blur), and a card
 * whose counter changes as fast as the renderer takes it. Writes the frame
 * count and draw-time stats of the timed window to the result file.
 *
 * bun tools/native/blur-cost-scene.tsx <result.json> <sigma> <seconds>
 */
import { writeFileSync } from 'node:fs'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'

const [resultFile, sigmaArg = '8', secondsArg = '4'] = process.argv.slice(2)
const SIGMA = Number(sigmaArg)
const SECONDS = Number(secondsArg)
const WARMUP_MS = 1500

interface Stats {
  p90Ms?: number
  p99Ms?: number
  maxMs?: number
  frames: number
  samples: number
}
interface LiveRenderer {
  setDebugFrameOverlay(mode: string): string
  resetDebugFrameOverlayStats(): void
  getDebugFrameOverlayStats(): Stats
}

function App() {
  const renderer = useGpuixRequired() as unknown as LiveRenderer
  const [tick, setTick] = useState(0)
  useEffect(() => {
    renderer.setDebugFrameOverlay('minimal')
    let running = true
    const pump = () => {
      if (!running) return
      setTick((t) => t + 1)
      setTimeout(pump, 1)
    }
    pump()
    let start: Stats | undefined
    let startedAt = 0
    const begin = setTimeout(() => {
      renderer.resetDebugFrameOverlayStats()
      start = renderer.getDebugFrameOverlayStats()
      startedAt = performance.now()
    }, WARMUP_MS)
    const end = setTimeout(
      () => {
        const stats = renderer.getDebugFrameOverlayStats()
        const elapsedMs = performance.now() - startedAt
        const frames = stats.frames - (start?.frames ?? 0)
        running = false
        writeFileSync(
          resultFile as string,
          JSON.stringify({ sigma: SIGMA, elapsedMs, frames, msPerFrame: elapsedMs / frames, stats })
        )
        process.exit(0)
      },
      WARMUP_MS + SECONDS * 1000
    )
    return () => {
      running = false
      clearTimeout(begin)
      clearTimeout(end)
    }
  }, [renderer])
  const line = { fontSize: 14, lineHeight: 20, color: '#e5e5e6' }
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#08090a',
        flexDirection: 'column',
        padding: 16
      }}
    >
      {Array.from({ length: 38 }, (_, i) => (
        <text key={i} style={line}>
          {`${i} The quick brown fox jumps over the lazy dog; terminals, chats and diffs live behind this scrim.`}
        </text>
      ))}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#00000099',
          ...(SIGMA > 0 ? { backdropBlur: SIGMA } : {})
        }}
      >
        <div style={{ width: 420, padding: 24, borderRadius: 12, backgroundColor: '#161718' }}>
          <text style={line}>{`frame ${tick}`}</text>
        </div>
      </div>
    </div>
  )
}

if (resultFile) {
  render(<App />, {
    title: 'termul-blur-cost',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focus: false
  })
}
