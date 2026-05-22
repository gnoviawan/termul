/**
 * Generic no-op mock for @tauri-apps/plugin-* packages
 * Catches all plugin imports (plugin-store, plugin-fs, plugin-dialog, etc.)
 * so web builds don't crash at import time.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default {} as any

const noopVoid = async (): Promise<void> => {}
const noopNull = async (): Promise<null> => null
const noopFalse = async (): Promise<boolean> => false
const noopStr = async (): Promise<string> => ''

// @tauri-apps/plugin-store — Store class mock
export class Store {
  constructor(_path: string) {}
  async get<T = unknown>(_key: string): Promise<T | null> { return null }
  async set(_key: string, _value: unknown): Promise<void> {}
  async delete(_key: string): Promise<boolean> { return false }
  async has(_key: string): Promise<boolean> { return false }
  async clear(): Promise<void> {}
  async reset(): Promise<void> {}
  async keys(): Promise<string[]> { return [] }
  async values(): Promise<unknown[]> { return [] }
  async entries(): Promise<[string, unknown][]> { return [] }
  async length(): Promise<number> { return 0 }
  async load(): Promise<void> {}
  async save(): Promise<void> {}
  async close(): Promise<void> {}
  onChange(_cb: unknown): () => void { return () => {} }
}

// @tauri-apps/plugin-fs
export const readTextFile = noopStr
export const writeTextFile = noopVoid
export const exists = noopFalse
export const readDir = async (): Promise<[]> => []
export const mkdir = noopVoid
export const remove = noopVoid
export const rename = noopVoid
export const copyFile = noopVoid
export const stat = noopNull
export const lstat = noopNull
export const watch = async (): Promise<() => void> => () => {}
export const watchImmediate = async (): Promise<() => void> => () => {}
export const BaseDirectory = {}
export const readFile = async (): Promise<Uint8Array> => new Uint8Array(0)
export const writeFile = noopVoid
export const truncate = noopVoid
export const create = noopNull

// @tauri-apps/plugin-dialog
export const open = noopNull
export const save = noopNull
export const message = noopVoid
export const confirm = noopFalse
export const ask = noopFalse

// @tauri-apps/plugin-clipboard-manager
export const readText = noopStr
export const writeText = noopVoid

// @tauri-apps/plugin-opener
export const openPath = noopVoid
export const openUrl = noopVoid
export const revealItemInDir = noopVoid

// @tauri-apps/plugin-os
export const platform = async (): Promise<string> => 'web'
export const arch = async (): Promise<string> => 'x86_64'
export const version = async (): Promise<string> => '0.0.0'
export const type = async (): Promise<string> => 'Linux'
export const family = async (): Promise<string> => 'unix'
export const hostname = noopNull
export const locale = noopNull
export const exeExtension = async (): Promise<string> => ''

// @tauri-apps/plugin-process
export const relaunch = noopVoid
export const exit = noopVoid

// @tauri-apps/plugin-updater
export const check = noopNull
