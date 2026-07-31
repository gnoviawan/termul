/**
 * Sync OS stubs for the web build.
 *
 * Several App-graph call sites compare `platform()` / `arch()` synchronously
 * (e.g. `platform() === 'windows'`). Rejecting would schedule unhandled
 * rejections; returning stable sentinels keeps the web shell quiet.
 */
export function platform(): string {
  return 'linux'
}

export function arch(): string {
  return 'x86_64'
}

export function version(): string {
  return 'web'
}

export function locale(): string | null {
  return null
}

export function hostname(): string {
  return 'localhost'
}
