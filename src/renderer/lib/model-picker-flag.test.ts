import { beforeEach, describe, expect, it } from 'vitest'
import { isModelPickerV2Enabled, MODEL_PICKER_V2_KEY } from './model-picker-flag'

describe('isModelPickerV2Enabled', () => {
  beforeEach(() => localStorage.removeItem(MODEL_PICKER_V2_KEY))

  it('is on by default', () => {
    expect(isModelPickerV2Enabled()).toBe(true)
  })

  it('stays on when the key is 1', () => {
    localStorage.setItem(MODEL_PICKER_V2_KEY, '1')
    expect(isModelPickerV2Enabled()).toBe(true)
  })

  it('falls back to the old picker when the key is 0', () => {
    localStorage.setItem(MODEL_PICKER_V2_KEY, '0')
    expect(isModelPickerV2Enabled()).toBe(false)
  })
})
