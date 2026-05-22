/**
 * Mock for @tauri-apps/api/event
 * Used in web (non-Tauri) context to prevent import errors.
 */

export type UnlistenFn = () => void

export type EventCallback<T> = (event: { payload: T }) => void

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listen<T = any>(
  _event: string,
  _callback: EventCallback<T>
): Promise<UnlistenFn> {
  // No-op in web context
  return () => {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function once<T = any>(
  _event: string,
  _callback: EventCallback<T>
): Promise<UnlistenFn> {
  return () => {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function emit(_event: string, _payload?: any): Promise<void> {
  // no-op
}
