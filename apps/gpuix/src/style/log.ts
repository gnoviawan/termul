/** GPUIX-only logger for the style layer. Dev builds only; never logs user content. */
const enabled = process.env.NODE_ENV !== 'production' && process.env.GPUIX_STYLE_LOG !== '0'

export const styleLog = {
  warn(message: string, detail?: Record<string, unknown>): void {
    if (!enabled) return
    console.warn(`[gpuix:style] ${message}`, detail ?? '')
  },
  info(message: string, detail?: Record<string, unknown>): void {
    if (!enabled) return
    console.info(`[gpuix:style] ${message}`, detail ?? '')
  }
}
