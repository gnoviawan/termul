import { tauriUnavailable } from './unavailable'

export async function getVersion(): Promise<never> {
  return tauriUnavailable('app.getVersion')
}

export async function getName(): Promise<never> {
  return tauriUnavailable('app.getName')
}

export async function getTauriVersion(): Promise<never> {
  return tauriUnavailable('app.getTauriVersion')
}
