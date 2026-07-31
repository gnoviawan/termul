import { tauriUnavailable } from './unavailable'

export type FileInfo = {
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
  size: number
  mtime: Date | null
  atime: Date | null
  birthtime: Date | null
  readonly: boolean
}

export type DirEntry = {
  name: string
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
}

export type WatchEvent = unknown

export async function copyFile(_from: string, _to: string): Promise<never> {
  return tauriUnavailable('fs.copyFile')
}

export async function mkdir(_path: string, _options?: unknown): Promise<never> {
  return tauriUnavailable('fs.mkdir')
}

export async function open(_path: string, _options?: unknown): Promise<never> {
  return tauriUnavailable('fs.open')
}

export async function readDir(_path: string): Promise<never> {
  return tauriUnavailable('fs.readDir')
}

export async function readTextFile(_path: string): Promise<never> {
  return tauriUnavailable('fs.readTextFile')
}

export async function remove(_path: string, _options?: unknown): Promise<never> {
  return tauriUnavailable('fs.remove')
}

export async function rename(_from: string, _to: string): Promise<never> {
  return tauriUnavailable('fs.rename')
}

export async function stat(_path: string): Promise<never> {
  return tauriUnavailable('fs.stat')
}

export async function writeTextFile(_path: string, _contents: string): Promise<never> {
  return tauriUnavailable('fs.writeTextFile')
}

export async function writeFile(
  _path: string,
  _contents: Uint8Array | ArrayBuffer
): Promise<never> {
  return tauriUnavailable('fs.writeFile')
}

export async function watchImmediate(
  _path: string,
  _callback: (event: WatchEvent) => void,
  _options?: unknown
): Promise<() => void> {
  return tauriUnavailable('fs.watchImmediate')
}

export async function exists(_path: string): Promise<boolean> {
  return false
}

export async function readFile(_path: string): Promise<never> {
  return tauriUnavailable('fs.readFile')
}
