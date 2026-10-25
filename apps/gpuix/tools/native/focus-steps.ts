/** Shared by `focus-scene.tsx` and `focus-check.ts`: the steps and the DOM's events for each in an active window. */
export const FOCUS_STEPS = [
  { id: 'mount', what: 'mount, A autoFocus', dom: ['focus A'] },
  { id: 'focusB', what: 'focusElement(B)', dom: ['blur A', 'focus B'] },
  { id: 'focusA', what: 'focusElement(A)', dom: ['blur B', 'focus A'] },
  { id: 'deactivate', what: 'window loses the X input focus', dom: ['blur A'] },
  { id: 'reactivate', what: 'window gets the X input focus back', dom: ['focus A'] }
] as const
