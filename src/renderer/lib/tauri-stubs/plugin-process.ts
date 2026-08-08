import { tauriUnavailable } from './unavailable'

export async function relaunch(): Promise<never> {
  return tauriUnavailable('process.relaunch')
}

export async function exit(_code?: number): Promise<never> {
  return tauriUnavailable('process.exit')
}
