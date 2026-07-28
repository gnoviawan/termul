import { tauriUnavailable } from './unavailable'

export async function appDataDir(): Promise<never> {
  return tauriUnavailable('path.appDataDir')
}

export async function tempDir(): Promise<never> {
  return tauriUnavailable('path.tempDir')
}

export async function join(..._paths: string[]): Promise<never> {
  return tauriUnavailable('path.join')
}

export async function homeDir(): Promise<never> {
  return tauriUnavailable('path.homeDir')
}

export async function dirname(_path: string): Promise<never> {
  return tauriUnavailable('path.dirname')
}

export async function basename(_path: string): Promise<never> {
  return tauriUnavailable('path.basename')
}
