/**
 * The window `focus-check.ts` drives: two focusable boxes shaped like the
 * terminal host (a `div` with `tabIndex` and onFocus/onBlur). Each step waits
 * for the driver's `<dir>/go-<n>` file, acts, waits a beat, and records the
 * focus events it saw and the renderer's focused id; then it writes
 * `<dir>/done-<n>`. Steps: mount with box A `autoFocus`, `focusElement(B)`,
 * `focusElement(A)`, then two the driver performs on the X window
 * (deactivate, reactivate). The last step writes `<dir>/result.json`.
 *
 * bun tools/native/focus-scene.tsx <dir>
 */
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type PublicInstance, render, useGpuixRequired } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import { FOCUS_STEPS } from './focus-steps'

const [dir] = process.argv.slice(2)
const SETTLE_MS = 500

interface LiveRenderer {
  focusElement(id: number): void
  getFocusedElementId(): number | null
}

const events: string[] = []

async function waitFor(file: string): Promise<void> {
  while (!existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 20))
}

function App() {
  const renderer = useGpuixRequired() as unknown as LiveRenderer
  const [mounted, setMounted] = useState(false)
  const a = useRef<PublicInstance | null>(null)
  const b = useRef<PublicInstance | null>(null)
  useEffect(() => {
    const name = (id: number | null) =>
      id === null ? null : id === a.current?.id ? 'A' : id === b.current?.id ? 'B' : String(id)
    const actions: Record<string, () => void> = {
      mount: () => setMounted(true),
      focusB: () => renderer.focusElement(b.current?.id as number),
      focusA: () => renderer.focusElement(a.current?.id as number)
    }
    void (async () => {
      const steps = []
      for (const [n, step] of FOCUS_STEPS.entries()) {
        await waitFor(path.join(dir as string, `go-${n}`))
        actions[step.id]?.()
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
        steps.push({
          step: step.id,
          focused: name(renderer.getFocusedElementId()),
          events: events.splice(0)
        })
        writeFileSync(path.join(dir as string, `done-${n}`), '')
      }
      writeFileSync(path.join(dir as string, 'result.json'), JSON.stringify(steps))
      process.exit(0)
    })()
  }, [renderer])
  const box = (label: 'A' | 'B', ref: typeof a, autoFocus: boolean) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: shaped like the terminal host, a focusable plain box
    <div
      ref={(node: PublicInstance | null) => {
        ref.current = node
      }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the terminal host is a focusable plain box
      tabIndex={0}
      // biome-ignore lint/a11y/noAutofocus: autoFocus on mount is the case under test
      autoFocus={autoFocus}
      onFocus={() => events.push(`focus ${label}`)}
      onBlur={() => events.push(`blur ${label}`)}
      style={{ width: 120, height: 80, backgroundColor: '#333333' }}
    />
  )
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#000000',
        display: 'flex',
        gap: 16
      }}
    >
      {mounted ? box('A', a, true) : null}
      {mounted ? box('B', b, false) : null}
    </div>
  )
}

if (dir) render(<App />, { title: 'termul-focus-check', width: 320, height: 200, focus: false })
