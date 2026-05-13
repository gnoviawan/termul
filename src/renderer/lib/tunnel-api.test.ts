import { describe, expect, it, vi } from 'vitest'
import { tunnelApi } from './tunnel-api'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ success: true, data: [] })) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

describe('tunnelApi', () => {
  it('exposes list method', async () => {
    const result = await tunnelApi.list()
    expect(result.success).toBe(true)
  })
})
