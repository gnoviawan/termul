/**
 * Boundary and failure log for GPUIX-only terminal code. Shared renderer code
 * keeps logging through `src/renderer/lib/log-api.ts`; this one writes to
 * stderr so a headless run (Xvfb, automation) keeps a readable trail.
 */
export function terminalLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {}
): void {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  const line = `[gpuix-terminal] ${level} ${event}${parts.length ? ` ${parts.join(' ')}` : ''}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.error(line)
}
