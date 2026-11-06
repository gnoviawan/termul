import type { Point } from './camera'

export const PAN_STEP = 80
export const PAN_STEP_LARGE = 320

export type ViewportKeyCommand =
  | { type: 'pan'; by: Point }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'reset' }
  | { type: 'fit' }

type KeyInput = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

/**
 * Camera command for a key pressed while the canvas itself has focus.
 * Ctrl, Meta and Alt chords belong to the browser (find, zoom, back/forward).
 */
export function viewportKeyCommand(event: KeyInput): ViewportKeyCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const step = event.shiftKey ? PAN_STEP_LARGE : PAN_STEP
  switch (event.key) {
    case 'ArrowLeft':
      return { type: 'pan', by: { x: step, y: 0 } }
    case 'ArrowRight':
      return { type: 'pan', by: { x: -step, y: 0 } }
    case 'ArrowUp':
      return { type: 'pan', by: { x: 0, y: step } }
    case 'ArrowDown':
      return { type: 'pan', by: { x: 0, y: -step } }
    case '+':
    case '=':
      return { type: 'zoom-in' }
    case '-':
    case '_':
      return { type: 'zoom-out' }
    case '0':
      return { type: 'reset' }
    case 'f':
    case 'F':
      return { type: 'fit' }
    default:
      return null
  }
}
