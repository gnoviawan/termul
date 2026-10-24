/**
 * Opt-in flag for the v2 model picker view. Off unless this key is '1':
 * `localStorage.setItem('termul.modelPickerV2', '1')`, then reopen the picker.
 */
export const MODEL_PICKER_V2_KEY = 'termul.modelPickerV2'

export function isModelPickerV2Enabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(MODEL_PICKER_V2_KEY) === '1'
  } catch {
    return false
  }
}
