/** Shared by the patch scene and its checker. */
export const SCENE = { width: 640, height: 420 } as const
export const SAMPLES = ['upright', 'italic', 'link', 'codeFull', 'codeHalf'] as const
export type Sample = (typeof SAMPLES)[number]
export interface SceneReady {
  bounds: Record<Sample, { x: number; y: number; width: number; height: number } | null>
  handle: { kind: string; id?: number | null } | null
  pid: number
}
