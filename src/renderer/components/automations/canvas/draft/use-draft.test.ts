import type { AutomationLayout } from '@shared/types/automation.types'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detailWith } from '@/lib/test-utils/automation-fixtures'

const api = vi.hoisted(() => ({
  applyAutomationOps: vi.fn(),
  getAutomation: vi.fn(),
  onAutomationChanged: vi.fn(() => () => {}),
  previewAutomationOps: vi.fn(),
  setAutomationLayout: vi.fn()
}))
vi.mock('@/lib/automation-api', () => api)
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import { useDraft } from './use-draft'

const ok = <T>(data: T) => ({ success: true as const, data })
const base: AutomationLayout = { trigger: { x: 0, y: 0 }, fetch: { x: 240, y: 0 } }
const detail = detailWith({ revision: 3, layout: base })

beforeEach(() => vi.clearAllMocks())

describe('useDraft', () => {
  it('writes only its own positions onto the layout the head has just before the write', async () => {
    // Another author stored a position for `extract` after this draft opened.
    const head = detailWith({
      revision: 3,
      layout: { ...base, fetch: { x: 240, y: 0 }, extract: { x: 900, y: 900 } }
    })
    api.getAutomation.mockResolvedValue(ok(head))
    api.setAutomationLayout.mockImplementation(async (_id, layout) =>
      ok({ ...head.automation, layout })
    )
    const { result } = renderHook(() => useDraft(detail, vi.fn()))

    act(() => {
      result.current.apply([], { fetch: { x: 300, y: 40 } })
    })
    await act(() => result.current.save())

    expect(api.setAutomationLayout).toHaveBeenCalledWith(detail.automation.id, {
      trigger: { x: 0, y: 0 },
      fetch: { x: 300, y: 40 },
      extract: { x: 900, y: 900 }
    })
    expect(result.current.draft.pending).toEqual([])
  })

  it('refuses gestures and discard while Save runs, and says it is saving', async () => {
    let answer: (value: unknown) => void = () => {}
    api.getAutomation.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { result } = renderHook(() => useDraft(detail, vi.fn()))
    act(() => {
      result.current.apply([], { fetch: { x: 1, y: 1 } })
    })
    let saving: Promise<void> = Promise.resolve()
    act(() => {
      saving = result.current.save()
    })
    await waitFor(() => expect(result.current.saving).toBe(true))

    let refusal: ReturnType<typeof result.current.apply> = null
    act(() => {
      refusal = result.current.apply([], { fetch: { x: 2, y: 2 } })
      result.current.discard()
    })
    expect(refusal).toEqual({ code: 'saving' })
    expect(result.current.draft.pending).toHaveLength(1)
    expect(result.current.draft.layout.fetch).toEqual({ x: 1, y: 1 })

    api.setAutomationLayout.mockResolvedValue(ok({ ...detail.automation }))
    await act(async () => {
      answer(ok(detail))
      await saving
    })
    expect(result.current.saving).toBe(false)
  })
})
