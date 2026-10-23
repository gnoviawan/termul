import type { SurfaceResult } from './types'

export function writeReport(results: Record<string, SurfaceResult>): void {
  console.error(`[matrix] ${Object.keys(results).length} surfaces in results`)
}
