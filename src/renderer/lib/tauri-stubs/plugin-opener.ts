import { tauriUnavailable } from './unavailable'

export async function openUrl(_url: string): Promise<never> {
  return tauriUnavailable('opener.openUrl')
}

export async function openPath(_path: string): Promise<never> {
  return tauriUnavailable('opener.openPath')
}

export async function revealItemInDir(_path: string): Promise<never> {
  return tauriUnavailable('opener.revealItemInDir')
}
