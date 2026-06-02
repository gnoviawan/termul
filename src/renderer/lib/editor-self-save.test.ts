import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeEditorSelfSave, markEditorSelfSave } from './editor-self-save'

describe('editor-self-save', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('consumes a recent self-save once', () => {
    markEditorSelfSave('/project/readme.md')
    expect(consumeEditorSelfSave('/project/readme.md')).toBe(true)
    expect(consumeEditorSelfSave('/project/readme.md')).toBe(false)
  })

  it('does not consume after grace period', () => {
    markEditorSelfSave('/project/readme.md')
    vi.advanceTimersByTime(4000)
    expect(consumeEditorSelfSave('/project/readme.md')).toBe(false)
  })
})
