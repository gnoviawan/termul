import { DESKTOP_WINDOW, type WindowSize } from '../window'

/**
 * The window's initial size: the desktop app's, or `GPUIX_WINDOW_SIZE=WxH`
 * (the parity harness and the startup bench pin it). A size under the
 * desktop minimum is raised to it, like the OS would.
 */
export function readInitialWindowSize(env: NodeJS.ProcessEnv = process.env): WindowSize {
  const raw = env.GPUIX_WINDOW_SIZE?.trim()
  const match = raw?.match(/^(\d+)x(\d+)$/)
  if (raw && !match) throw new Error(`GPUIX_WINDOW_SIZE must be WIDTHxHEIGHT: ${JSON.stringify(raw)}`)
  const width = match ? Number(match[1]) : DESKTOP_WINDOW.width
  const height = match ? Number(match[2]) : DESKTOP_WINDOW.height
  return {
    width: Math.max(width, DESKTOP_WINDOW.minWidth),
    height: Math.max(height, DESKTOP_WINDOW.minHeight)
  }
}
