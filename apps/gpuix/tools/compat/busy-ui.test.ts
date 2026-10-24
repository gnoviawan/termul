import { expect, test } from 'bun:test'
import { tolerateBusyFocusReads } from '../../src/compat/busy-ui'

function reader(answer: () => number | null): { getFocusedElementId: () => number | null } {
  return { getFocusedElementId: answer }
}

test('a focus read the busy UI thread timed out on answers no focused element', () => {
  const renderer = reader(() => {
    throw new Error('Timed out after 2 seconds waiting for the focused element id query')
  })
  tolerateBusyFocusReads(renderer)
  expect(renderer.getFocusedElementId()).toBeNull()
})

test('a focus read that answers is unchanged, and any other failure still throws', () => {
  const answering = reader(() => 42)
  tolerateBusyFocusReads(answering)
  expect(answering.getFocusedElementId()).toBe(42)

  const broken = reader(() => {
    throw new Error('GPUIX renderer is not initialized')
  })
  tolerateBusyFocusReads(broken)
  expect(() => broken.getFocusedElementId()).toThrow('GPUIX renderer is not initialized')
})

test('restoring puts the original read back', () => {
  const original = () => 7
  const renderer = reader(original)
  const restore = tolerateBusyFocusReads(renderer)
  restore()
  expect(renderer.getFocusedElementId).toBe(original)
})
