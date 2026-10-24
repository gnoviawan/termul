/**
 * One bench run inside the GPUIX process: mount the list, time it, rename
 * rows, sweep the pointer over the rows, write the numbers to $BENCH_OUT.
 * Both subjects mount inside `CompatRoot`, so the root costs the same.
 */

import { flushSync, render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { CompatList } from '#compat/bench-dom'
import { CompatRoot, compatRenderOptions } from '../../../src/compat/root'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import type { BenchHost, RunBench } from './app-contract'
import { ROWS, useBenchStore } from './data'
import { HandList } from './HandList'

type Mode = 'compat' | 'hand'

const WARM_MOUNTS = 10
const RERENDERS = 30
/** Lavapipe paints a frame in ~50 ms on this host; a sample must not start inside the last one. */
const SAMPLE_GAP_MS = 250

interface LiveRenderer {
  simulateMouseMove(x: number, y: number): void
  setDebugFrameOverlay(mode: string): string
  resetDebugFrameOverlayStats(): void
  getDebugFrameOverlayStats(): {
    p90Ms?: number
    p99Ms?: number
    maxMs?: number
    currentMs?: number
    frames: number
    samples: number
  }
  getAutomationTree(): string
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function countNodes(json: string): number {
  return (json.match(/"id":/g) ?? []).length
}

/** Back-to-back iterations for `bun --cpu-prof`: no sleeps, so the profile is the work. */
async function profileLoop(host: BenchHost, setShow: (show: boolean) => void): Promise<void> {
  const ITERATIONS = host.iterations ?? (host.profile === 'mount' ? 200 : 1000)
  const t0 = performance.now()
  const c0 = host.cpuMicros()
  for (let i = 0; i < ITERATIONS; i++) {
    if (host.profile === 'mount') {
      flushSync(() => setShow(true))
      flushSync(() => setShow(false))
    } else {
      if (i === 0) flushSync(() => setShow(true))
      flushSync(() => useBenchStore.getState().rename(5 + (i % 10), `renamed ${i}`))
    }
  }
  host.write(
    JSON.stringify({
      profile: host.profile,
      iterations: ITERATIONS,
      msPerIteration: (performance.now() - t0) / ITERATIONS,
      cpuMsPerIteration: (host.cpuMicros() - c0) / 1000 / ITERATIONS
    })
  )
  host.exit()
}

function Bench({ mode, host }: { mode: Mode; host: BenchHost }) {
  const renderer = useGpuixRequired() as unknown as LiveRenderer
  const [show, setShow] = useState(false)
  useEffect(() => {
    void (async () => {
      await host.sleep(1500)
      if (host.profile) {
        await profileLoop(host, setShow)
        return
      }
      host.gc()
      const t0 = performance.now()
      flushSync(() => setShow(true))
      const mountMs = performance.now() - t0
      await host.sleep(800)
      const warmMounts: number[] = []
      for (let i = 0; i < WARM_MOUNTS; i++) {
        flushSync(() => setShow(false))
        await host.sleep(SAMPLE_GAP_MS)
        host.gc()
        const w0 = performance.now()
        flushSync(() => setShow(true))
        warmMounts.push(performance.now() - w0)
        await host.sleep(SAMPLE_GAP_MS)
      }
      await host.sleep(1000)
      const nodes = countNodes(renderer.getAutomationTree())
      const rerender: number[] = []
      for (let i = 0; i < RERENDERS; i++) {
        const index = 5 + (i % 10)
        const r0 = performance.now()
        flushSync(() => useBenchStore.getState().rename(index, `renamed ${i}`))
        rerender.push(performance.now() - r0)
        await host.sleep(SAMPLE_GAP_MS)
      }
      await host.sleep(500)
      const renamedPainted = renderer.getAutomationTree().includes(`renamed ${RERENDERS - 1}`)
      renderer.setDebugFrameOverlay('minimal')
      await host.sleep(300)
      renderer.resetDebugFrameOverlayStats()
      for (let sweep = 0; sweep < 3; sweep++) {
        for (let row = 0; row < Math.min(ROWS, 20); row++) {
          renderer.simulateMouseMove(120, 8 + row * 34 + 16)
          await host.sleep(40)
        }
      }
      const frames = renderer.getDebugFrameOverlayStats()
      renderer.simulateMouseMove(120, 8 + 3 * 34 + 16)
      await host.sleep(300)
      const hoverShowsActions = renderer.getAutomationTree().includes('Ctrl+4')
      host.gc()
      await host.sleep(300)
      const rss = host.rssBytes()
      host.write(
        JSON.stringify({
          mode,
          rows: ROWS,
          mountMs,
          warmMountMs: median(warmMounts),
          warmMounts,
          rerenderMs: median(rerender),
          rerender,
          frames,
          rssMb: rss / 2 ** 20,
          nodes,
          renamedPainted,
          hoverShowsActions
        })
      )
      host.exit()
    })()
  }, [renderer, host])
  if (!show) return null
  return mode === 'compat' ? <CompatList /> : <HandList />
}

export const runBench: RunBench = (mode, host, onRenderer) => {
  render(
    <CompatRoot onRenderer={onRenderer}>
      <Bench mode={mode} host={host} />
    </CompatRoot>,
    {
      title: `bench ${mode}`,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      focus: false,
      ...compatRenderOptions
    }
  )
}
