import { vi } from 'vitest'

export const ZhipuAI = vi.fn().mockImplementation(() => ({
  createCompletions: vi.fn()
}))

export const mockCreateCompletions = vi.fn()
