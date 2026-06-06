import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@/lib/acp-api'
import { partitionConfigOptions } from './chat-input-bar-config'

function opt(id: string, category: string | null): SessionConfigOption {
  return {
    id,
    name: id,
    category,
    type: 'select',
    currentValue: 'a',
    description: null,
    options: [
      { value: 'a', name: 'A', description: null },
      { value: 'b', name: 'B', description: null }
    ]
  }
}

describe('partitionConfigOptions', () => {
  it('returns null thoughtLevel and empty rest for no options', () => {
    expect(partitionConfigOptions([])).toEqual({ thoughtLevel: null, rest: [] })
  })

  it('promotes a thought_level option and leaves rest empty', () => {
    const tl = opt('reasoning', 'thought_level')
    const result = partitionConfigOptions([tl])
    expect(result.thoughtLevel).toBe(tl)
    expect(result.rest).toEqual([])
  })

  it('keeps generic options in rest when no thought_level present', () => {
    const mode = opt('mode', 'mode')
    const model = opt('model', 'model')
    const result = partitionConfigOptions([mode, model])
    expect(result.thoughtLevel).toBeNull()
    expect(result.rest).toEqual([mode, model])
  })

  it('partitions mixed options, preserving rest order', () => {
    const mode = opt('mode', 'mode')
    const tl = opt('reasoning', 'thought_level')
    const model = opt('model', 'model')
    const result = partitionConfigOptions([mode, tl, model])
    expect(result.thoughtLevel).toBe(tl)
    expect(result.rest).toEqual([mode, model])
  })

  it('treats unknown categories as generic rest', () => {
    const custom = opt('custom', 'something-new')
    const result = partitionConfigOptions([custom])
    expect(result.thoughtLevel).toBeNull()
    expect(result.rest).toEqual([custom])
  })

  it('promotes only the first thought_level option, rest keeps the others', () => {
    const tl1 = opt('reasoning1', 'thought_level')
    const tl2 = opt('reasoning2', 'thought_level')
    const result = partitionConfigOptions([tl1, tl2])
    expect(result.thoughtLevel).toBe(tl1)
    expect(result.rest).toEqual([tl2])
  })
})
