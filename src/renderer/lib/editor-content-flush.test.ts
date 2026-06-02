import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  flushEditorContent,
  registerEditorContentFlusher,
  unregisterEditorContentFlusher
} from './editor-content-flush'

describe('editor-content-flush', () => {
  const path = '/project/readme.md'

  beforeEach(() => {
    unregisterEditorContentFlusher(path)
  })

  it('invokes registered flusher for path', async () => {
    const flush = vi.fn()
    registerEditorContentFlusher(path, flush)

    await flushEditorContent(path)

    expect(flush).toHaveBeenCalledOnce()
  })

  it('awaits async flushers', async () => {
    const order: string[] = []
    registerEditorContentFlusher(path, async () => {
      await Promise.resolve()
      order.push('flush')
    })

    await flushEditorContent(path)
    order.push('after')

    expect(order).toEqual(['flush', 'after'])
  })

  it('no-ops when no flusher is registered', async () => {
    await expect(flushEditorContent(path)).resolves.toBeUndefined()
  })
})
