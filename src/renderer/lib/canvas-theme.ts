/**
 * The `host.theme` payload: Termul's semantic tokens as `#rrggbb`, in the key
 * set the fork's `Tokens::from_host` reads (figcraft SPIKE.md, "Theme,
 * locale and brand"). Every key is required by the editor.
 */

import { readCssTokenHex } from './themes/read-css-token'

export interface CanvasThemeTokens {
  mode: 'light' | 'dark'
  background: string
  card: string
  foreground: string
  mutedForeground: string
  border: string
  primary: string
  primaryFill: string
  destructive: string
}

/** The payload from a token reader: `hex` resolves a semantic token to
 * `#rrggbb` and throws when the theme lacks it. */
export function canvasThemeTokens(
  mode: CanvasThemeTokens['mode'],
  hex: (token: `--${string}`) => string
): CanvasThemeTokens {
  return {
    mode,
    background: hex('--background'),
    card: hex('--card'),
    foreground: hex('--foreground'),
    mutedForeground: hex('--muted-foreground'),
    border: hex('--border'),
    primary: hex('--primary'),
    primaryFill: hex('--primary-fill'),
    destructive: hex('--destructive')
  }
}

/** Read the applied theme. Throws when a token is missing from the document. */
export function readCanvasThemeTokens(): CanvasThemeTokens {
  return canvasThemeTokens(
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    readCssTokenHex
  )
}
