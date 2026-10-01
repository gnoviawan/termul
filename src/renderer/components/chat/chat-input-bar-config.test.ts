import { describe, expect, it } from 'vitest'
import type { SessionConfigOption, SessionModeState } from '@/lib/acp-api'
import {
  dropDuplicateSingletonConfigOptions,
  extractFastModeOption,
  filterDuplicateModeConfigOptions,
  isFastModeEnabled,
  isFastModeOption,
  oppositeFastModeValue,
  partitionConfigOptions
} from './chat-input-bar-config'

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
    expect(partitionConfigOptions([])).toEqual({ model: null, thoughtLevel: null, rest: [] })
  })

  it('promotes a thought_level option and leaves rest empty', () => {
    const tl = opt('reasoning', 'thought_level')
    const result = partitionConfigOptions([tl])
    expect(result.model).toBeNull()
    expect(result.thoughtLevel).toBe(tl)
    expect(result.rest).toEqual([])
  })

  it('promotes a model option and keeps generic options in rest', () => {
    const mode = opt('mode', 'mode')
    const model = opt('model', 'model')
    const result = partitionConfigOptions([mode, model])
    expect(result.model).toBe(model)
    expect(result.thoughtLevel).toBeNull()
    expect(result.rest).toEqual([mode])
  })

  it('partitions mixed options, preserving rest order', () => {
    const mode = opt('mode', 'mode')
    const tl = opt('reasoning', 'thought_level')
    const model = opt('model', 'model')
    const result = partitionConfigOptions([mode, tl, model])
    expect(result.model).toBe(model)
    expect(result.thoughtLevel).toBe(tl)
    expect(result.rest).toEqual([mode])
  })

  it('treats unknown categories as generic rest', () => {
    const custom = opt('custom', 'something-new')
    const result = partitionConfigOptions([custom])
    expect(result.model).toBeNull()
    expect(result.thoughtLevel).toBeNull()
    expect(result.rest).toEqual([custom])
  })

  it('promotes only the first thought_level option, and drops later duplicates (#444)', () => {
    const tl1 = opt('reasoning1', 'thought_level')
    const tl2 = opt('reasoning2', 'thought_level')
    const result = partitionConfigOptions([tl1, tl2])
    expect(result.model).toBeNull()
    expect(result.thoughtLevel).toBe(tl1)
    // The duplicate must not resurface as a generic chip — that was the
    // second "Thinking: ..." control from the report.
    expect(result.rest).toEqual([])
  })

  it('promotes only the first model option, and drops later duplicates (#444)', () => {
    const model1 = opt('model1', 'model')
    const model2 = opt('model2', 'model')
    const result = partitionConfigOptions([model1, model2])
    expect(result.model).toBe(model1)
    expect(result.thoughtLevel).toBeNull()
    expect(result.rest).toEqual([])
  })
})

describe('filterDuplicateModeConfigOptions', () => {
  const modes: SessionModeState = {
    currentModeId: 'agent',
    availableModes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' }
    ]
  }

  it('keeps mode config options when native modes are absent', () => {
    const mode = opt('mode', 'mode')
    expect(filterDuplicateModeConfigOptions([mode], null)).toEqual([mode])
  })

  it('removes mode config options when native modes are present', () => {
    const mode = opt('mode', 'mode')
    const custom = opt('custom', 'custom')
    expect(filterDuplicateModeConfigOptions([mode, custom], modes)).toEqual([custom])
  })
})

describe('fast mode helpers', () => {
  function fastMode(currentValue = 'off'): SessionConfigOption {
    return {
      id: 'fast_mode',
      name: 'Fast Mode',
      category: 'other',
      type: 'select',
      currentValue,
      description: null,
      options: [
        { value: 'on', name: 'On', description: null },
        { value: 'off', name: 'Off', description: null }
      ]
    }
  }

  it('detects binary Fast Mode options and ignores unrelated selects', () => {
    expect(isFastModeOption(fastMode())).toBe(true)
    expect(isFastModeOption(opt('custom', 'other'))).toBe(false)
    expect(
      isFastModeOption({
        ...fastMode(),
        id: 'speed',
        name: 'Speed'
      })
    ).toBe(false)
  })

  it('resolves enabled state and opposite value', () => {
    expect(isFastModeEnabled(fastMode('off'))).toBe(false)
    expect(isFastModeEnabled(fastMode('on'))).toBe(true)
    expect(oppositeFastModeValue(fastMode('off'))).toBe('on')
    expect(oppositeFastModeValue(fastMode('on'))).toBe('off')
  })

  it('extracts Fast Mode from a generic options list', () => {
    const custom = opt('custom', 'other')
    const fm = fastMode('off')
    expect(extractFastModeOption([custom, fm])).toEqual({
      fastMode: fm,
      rest: [custom]
    })
    expect(extractFastModeOption([custom])).toEqual({ fastMode: null, rest: [custom] })
  })
})

describe('singleton-category dedupe (#444)', () => {
  it('partitionConfigOptions drops later thought_level/model options instead of leaking them into rest', () => {
    const first = opt('reasoning', 'thought_level')
    const dup = opt('reasoning2', 'thought_level')
    const firstModel = opt('model', 'model')
    const dupModel = opt('model2', 'model')
    const generic = opt('verbosity', 'verbosity')
    const result = partitionConfigOptions([first, dup, firstModel, dupModel, generic])
    expect(result.thoughtLevel?.id).toBe('reasoning')
    expect(result.model?.id).toBe('model')
    // The duplicates must NOT come back as generic chips — that is the
    // second "Thinking: ..." control from the report.
    expect(result.rest.map((o) => o.id)).toEqual(['verbosity'])
  })

  it('dropDuplicateSingletonConfigOptions keeps the first of each promoted category', () => {
    const a = opt('tl-a', 'thought_level')
    const b = opt('tl-b', 'thought_level')
    const m1 = opt('model-a', 'model')
    const m2 = opt('model-b', 'model')
    const generic = opt('other', 'other')
    // Original order preserved; only the later duplicates of promoted
    // categories disappear. Options without a category always survive.
    expect(dropDuplicateSingletonConfigOptions([a, generic, b, m1, m2]).map((o) => o.id)).toEqual([
      'tl-a',
      'other',
      'model-a'
    ])
  })
})
