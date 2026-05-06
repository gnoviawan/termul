import type { ITerminalOptions, Terminal as XtermTerminal } from '@xterm/xterm'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import {
  DEFAULT_TERMINAL_OPTIONS,
  getTerminalOptions,
  type TerminalRendererPreference,
} from './terminal-config'

export interface CreateTerminalSessionOptions {
  platform?: string
  fontFamily?: string
  fontSize?: number
  scrollback?: number
  convertEol?: boolean
  terminalOptions?: Partial<ITerminalOptions>
  loadSearchAddon?: boolean
  loadWebLinksAddon?: boolean
}

export interface CreateTerminalSessionResult {
  terminal: XtermTerminal
  fitAddon: FitAddon
  searchAddon?: SearchAddon
  webLinksAddon?: WebLinksAddon
}

export interface LoadWebglAddonOptions {
  onContextLoss?: () => void
}

export function shouldUseWebglRenderer(
  rendererPreference: TerminalRendererPreference,
): boolean {
  return rendererPreference === 'webgl'
}

export function createTerminalSession(
  options: CreateTerminalSessionOptions = {},
): CreateTerminalSessionResult {
  const {
    platform,
    fontFamily,
    fontSize,
    scrollback,
    convertEol,
    terminalOptions,
    loadSearchAddon = false,
    loadWebLinksAddon = false,
  } = options

  const baseOptions = platform
    ? getTerminalOptions(platform)
    : { ...DEFAULT_TERMINAL_OPTIONS }

  const terminal = new Terminal({
    ...baseOptions,
    ...terminalOptions,
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize !== undefined ? { fontSize } : {}),
    ...(scrollback !== undefined ? { scrollback } : {}),
    ...(convertEol !== undefined ? { convertEol } : {}),
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  let searchAddon: SearchAddon | undefined
  if (loadSearchAddon) {
    searchAddon = new SearchAddon()
    terminal.loadAddon(searchAddon)
  }

  let webLinksAddon: WebLinksAddon | undefined
  if (loadWebLinksAddon) {
    webLinksAddon = new WebLinksAddon()
    terminal.loadAddon(webLinksAddon)
  }

  return {
    terminal,
    fitAddon,
    searchAddon,
    webLinksAddon,
  }
}

export function loadWebglAddon(
  terminal: XtermTerminal,
  options: LoadWebglAddonOptions = {},
): WebglAddon {
  const webglAddon = new WebglAddon()
  if (options.onContextLoss) {
    webglAddon.onContextLoss(options.onContextLoss)
  }
  terminal.loadAddon(webglAddon)
  return webglAddon
}
