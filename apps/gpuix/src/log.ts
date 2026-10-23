/**
 * Logger for GPUIX-only code. Shared renderer code keeps using
 * `@/lib/log-api`; this one covers the client process itself (boot, env,
 * window), where no server may be reachable yet. Never logs the token.
 */

type Level = 'info' | 'warn' | 'error'

function emit(level: Level, source: string, message: string): void {
  const line = `[termul-gpuix] ${level} ${source}: ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (source: string, message: string) => emit('info', source, message),
  warn: (source: string, message: string) => emit('warn', source, message),
  error: (source: string, message: string) => emit('error', source, message)
}
