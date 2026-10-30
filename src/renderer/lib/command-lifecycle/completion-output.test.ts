import { expect, it } from 'vitest'
import { parseCompletionOutput } from './completion-output'

function hexLine(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

it('completion output becomes rows', () => {
  const draft = 'git sta'
  const output = [hexLine('status'), 'not-hex', hexLine('stash'), hexLine('status')].join('\n')

  const rows = parseCompletionOutput(draft, 7, output)

  expect(rows).toEqual([
    { text: 'status', from: 4, to: 7 },
    { text: 'stash', from: 4, to: 7 }
  ])
  expect(draft).toBe('git sta')

  expect(parseCompletionOutput(draft, 7, '')).toEqual([])
  expect(parseCompletionOutput('git ', 4, hexLine('status'))).toEqual([
    { text: 'status', from: 4, to: 4 }
  ])
})

it('drops completion candidates that contain ESC or CR', () => {
  const draft = 'git sta'
  const output = [
    hexLine('status\x1b[201~'),
    hexLine('stash\rinjected'),
    hexLine('stash'),
    hexLine('status\tok'),
    hexLine('hidden\u200bname'),
    hexLine('bidi\u202ename'),
    hexLine('isolated\u2066name')
  ].join('\n')

  const rows = parseCompletionOutput(draft, 7, output)

  expect(rows.map((row) => row.text)).toEqual(['stash'])
})
