import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRoot, flushSync, type NativeRenderer } from '@gpuix/react'
import { installCometFrames } from '../../src/env/comet-frames'
import { cometSource, Spinner } from '../../src/ui/spinner'

test('every spinner steps in the same batch, sending the path of a frame file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-comet-test-'))
  installCometFrames(dir)
  const stepBatches: string[][] = []
  const renderer = {
    applyBatch(json: string): number[] {
      const srcs = (JSON.parse(json) as unknown[][])
        .filter((op) => op[0] === 'setCustomProp' && op[2] === 'src')
        .map((op) => op[3] as string)
      if (srcs.length > 0) stepBatches.push(srcs)
      return []
    }
  }
  const root = createRoot(renderer as unknown as NativeRenderer)
  flushSync(() =>
    root.render(
      <div>
        <Spinner />
        <Spinner />
        <Spinner size={12} />
      </div>
    )
  )
  stepBatches.length = 0
  await Bun.sleep(200)
  root.unmount()
  expect(stepBatches.length).toBeGreaterThan(3)
  for (const srcs of stepBatches) expect(srcs.length).toBe(3)
  const [first, , small] = stepBatches[0]
  const [, size, angle] = path.basename(first).match(/^(\d+)-(\d+)-\w+\.svg$/) ?? []
  expect(path.dirname(first)).toBe(dir)
  expect(readFileSync(first, 'utf8')).toBe(cometSource(Number(size), Number(angle)))
  expect(path.basename(small)).toStartWith(`12-${angle}-`)
})
