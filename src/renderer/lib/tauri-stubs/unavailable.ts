/** Shared “desktop-only” rejection for awaited Tauri calls in the web build. */
export function tauriUnavailable(api: string): Promise<never> {
  return Promise.reject(new Error(`${api} is unavailable in the web build`))
}
