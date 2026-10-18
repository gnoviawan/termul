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

/** Read the applied theme. Throws when a token is missing from the document. */
export function readCanvasThemeTokens(): CanvasThemeTokens {
  return {
    mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    background: readCssTokenHex('--background'),
    card: readCssTokenHex('--card'),
    foreground: readCssTokenHex('--foreground'),
    mutedForeground: readCssTokenHex('--muted-foreground'),
    border: readCssTokenHex('--border'),
    primary: readCssTokenHex('--primary'),
    primaryFill: readCssTokenHex('--primary-fill'),
    destructive: readCssTokenHex('--destructive')
  }
}
