/**
 * Mock for @tauri-apps/api/core
 * Used in web (non-Tauri) context to prevent import errors.
 */

export type InvokeArgs = Record<string, unknown>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function invoke<T = any>(_cmd: string, _args?: InvokeArgs): Promise<T> {
  throw new Error(`[tauri-mock] invoke("${_cmd}") called in web context`)
}

export class Channel<T = unknown> {
  onmessage: ((response: T) => void) | null = null
  readonly __CHANNEL_MARKER__ = true as const
  readonly id: number = Math.random()
}

export function transformCallback<T = unknown>(
  _callback: (response: T) => void,
  _once?: boolean
): number {
  return 0
}
