import { default as xterm6Module } from '@xterm6/xterm'
import { default as fitAddon6Module } from '@xterm6/addon-fit'
import { default as searchAddon6Module } from '@xterm6/addon-search'
import { default as webLinksAddon6Module } from '@xterm6/addon-web-links'
import { default as webglAddon6Module } from '@xterm6/addon-webgl'
import type { ITerminalOptions } from '@xterm/xterm'

type TerminalLike = {
  loadAddon: (addon: unknown) => void
}

export type Xterm6TerminalConstructor = new (options?: ITerminalOptions) => TerminalLike

export type Xterm6AddonConstructor<T = unknown> = new () => T

function pickCtor<T>(moduleValue: unknown, exportName: string): T {
  const record = moduleValue as Record<string, unknown> | undefined
  const fromDefault = record && typeof record.default === 'object'
    ? (record.default as Record<string, unknown>)[exportName]
    : undefined
  const direct = record?.[exportName]
  const candidate = direct ?? fromDefault

  if (typeof candidate !== 'function') {
    throw new Error(`Missing ${exportName} constructor in xterm 6 compatibility module`)
  }

  return candidate as T
}

export const Xterm6Terminal = pickCtor<Xterm6TerminalConstructor>(xterm6Module, 'Terminal')
export const Xterm6FitAddon = pickCtor<Xterm6AddonConstructor>(fitAddon6Module, 'FitAddon')
export const Xterm6SearchAddon = pickCtor<Xterm6AddonConstructor>(searchAddon6Module, 'SearchAddon')
export const Xterm6WebLinksAddon = pickCtor<Xterm6AddonConstructor>(webLinksAddon6Module, 'WebLinksAddon')
export const Xterm6WebglAddon = pickCtor<Xterm6AddonConstructor>(webglAddon6Module, 'WebglAddon')

export interface Xterm6PackageLine {
  xterm: string
  addonFit: string
  addonSearch: string
  addonWebLinks: string
  addonWebgl: string
}

export const XTERM_6_PACKAGE_LINE: Xterm6PackageLine = {
  xterm: '6.1.0-beta.215',
  addonFit: '0.12.0-beta.215',
  addonSearch: '0.17.0-beta.215',
  addonWebLinks: '0.13.0-beta.215',
  addonWebgl: '0.20.0-beta.215',
}
