import { tauriUnavailable } from './unavailable'

export async function confirm(_message: string, _options?: unknown): Promise<never> {
  return tauriUnavailable('dialog.confirm')
}

export async function message(_message: string, _options?: unknown): Promise<never> {
  return tauriUnavailable('dialog.message')
}

export async function open(_options?: unknown): Promise<never> {
  return tauriUnavailable('dialog.open')
}

export async function save(_options?: unknown): Promise<never> {
  return tauriUnavailable('dialog.save')
}

export async function ask(_message: string, _options?: unknown): Promise<never> {
  return tauriUnavailable('dialog.ask')
}
