/** Shared by the patch scene and its checker. */
export const SCENE = { width: 640, height: 420 } as const
export const SAMPLES = ['upright', 'italic', 'link', 'codeFull', 'codeHalf', 'input'] as const
/** Set on the unfocused input after mount, like a URL bar after a navigation: ink at the start, dots at the end. */
export const LONG_VALUE = `${'M'.repeat(10)}${'.'.repeat(120)}`
export type Sample = (typeof SAMPLES)[number]
export interface SceneReady {
  bounds: Record<Sample, { x: number; y: number; width: number; height: number } | null>
  handle: { kind: string; id?: number | null } | null
  pid: number
}
