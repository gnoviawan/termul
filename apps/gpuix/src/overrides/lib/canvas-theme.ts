/**
 * GPUIX `canvas-theme`: the same `host.theme` payload, read from the theme tw() resolves
 * against, because this process has no document whose computed style holds the tokens (there
 * `readCssTokenHex` throws and the editor would keep its own light theme).
 */

import { type CanvasThemeTokens, canvasThemeTokens } from '@/lib/canvas-theme'
import { getLastAppliedColorThemeId } from '@/lib/themes/apply-color-theme'
import { oklchComponentsToHex } from '@/lib/themes/color-utils'
import { resolveTwTheme } from '../../style/theme'

export { type CanvasThemeTokens, canvasThemeTokens } from '@/lib/canvas-theme'

export function readCanvasThemeTokens(): CanvasThemeTokens {
  const theme = resolveTwTheme(getLastAppliedColorThemeId())
  return canvasThemeTokens(theme.appearance === 'light' ? 'light' : 'dark', (token) => {
    const components = theme.vars[token]
    if (!components) throw new Error(`Missing theme token ${token}`)
    return oklchComponentsToHex(components)
  })
}
