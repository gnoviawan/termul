import { oklchComponentsToHex } from './color-utils'

/** Read a semantic token's "L C H" components from the document. */
export function readCssTokenComponents(token: `--${string}`): string {
  const inline = document.documentElement.style.getPropertyValue(token).trim()
  if (inline) return inline
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim()
}

/** Resolve a semantic token to #rrggbb for APIs that cannot take oklch(). */
export function readCssTokenHex(token: `--${string}`, fallbackComponents?: string): string {
  const components = readCssTokenComponents(token) || fallbackComponents || ''
  if (!components) {
    throw new Error(`Missing CSS token ${token}`)
  }
  return oklchComponentsToHex(components)
}
