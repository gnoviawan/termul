import { readCssTokenHex } from './read-css-token'

export interface TerminalSearchDecorations {
  matchBackground: string
  activeMatchBackground: string
  matchOverviewRuler: string
  activeMatchColorOverviewRuler: string
}

/** xterm SearchAddon colours from semantic tokens (not hardcoded hex). */
export function getTerminalSearchDecorations(): TerminalSearchDecorations {
  const match = readCssTokenHex('--search-match')
  const active = readCssTokenHex('--search-match-active')
  return {
    matchBackground: match,
    activeMatchBackground: active,
    matchOverviewRuler: match,
    activeMatchColorOverviewRuler: active
  }
}
