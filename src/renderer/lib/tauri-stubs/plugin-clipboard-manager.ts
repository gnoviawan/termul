import { tauriUnavailable } from './unavailable'

export async function readText(): Promise<never> {
  return tauriUnavailable('clipboard.readText')
}

export async function writeText(_text: string): Promise<never> {
  return tauriUnavailable('clipboard.writeText')
}

export async function readImage(): Promise<never> {
  return tauriUnavailable('clipboard.readImage')
}
