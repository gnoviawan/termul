/**
 * Reduced motion for the GPUIX client. The web reads
 * `prefers-reduced-motion`; GPUIX has no media queries, so the client reads
 * `TERMUL_GPUIX_REDUCED_MOTION=1` (parity runs set it, as Playwright sets
 * `reducedMotion: 'reduce'`).
 */
export function reducedMotion(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env?.TERMUL_GPUIX_REDUCED_MOTION === '1'
}
