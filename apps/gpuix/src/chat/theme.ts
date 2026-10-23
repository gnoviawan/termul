/**
 * Themes for the transcript's native text elements, from the same tokens the
 * web transcript paints with: Tailwind colours through tw(), and the syntax
 * map `syntaxThemeFor()` hands Shiki (`resolveSyntaxColors`), so `<code>`
 * colours match the web's fences and the editor.
 */

import type { GpuixTheme, StyleDesc, SyntaxTheme } from '@gpuix/react'
import { getColorThemeDefinition } from '@/lib/themes/bundled-themes'
import { resolveSyntaxColors } from '@/lib/themes/resolve-syntax'
import { normalizeThemeFamilyId } from '@/lib/themes/theme-appearance'
import { tw } from '../style/tw'
import { MONO_FAMILY, SANS_FAMILY } from '../style/utilities'

/** A Tailwind colour token (`foreground`, `muted-foreground`, `border/40`) as a CSS colour. */
export function tokenColor(token: string): string {
  const color = (tw(`text-${token}`) as StyleDesc).color
  return typeof color === 'string' ? color : '#ffffff'
}

/** Body text: `text-sm leading-normal`. */
export const PROSE_TEXT = 14
export const PROSE_LINE = 21

function syntaxTheme(themeId: string): SyntaxTheme {
  const c = resolveSyntaxColors(getColorThemeDefinition(normalizeThemeFamilyId(themeId)))
  return {
    comment: c.comment,
    keyword: c.keyword,
    string: c.string,
    stringSpecial: c.string,
    escape: c.string,
    number: c.number,
    boolean: c.bool,
    constant: c.bool,
    typeName: c.type,
    typeBuiltin: c.type,
    constructor: c.type,
    function: c.function,
    functionBuiltin: c.function,
    macroName: c.function,
    property: c.property,
    variable: c.variable,
    variableSpecial: c.definition,
    parameter: c.property,
    operator: c.operator,
    punctuation: c.punctuation,
    tag: c.tag,
    attribute: c.attributeName,
    label: c.heading
  }
}

const cache = new Map<string, { prose: GpuixTheme; thought: GpuixTheme; code: GpuixTheme }>()

/**
 * - `prose`: an agent reply block (`.chat-streamdown`): 14/21 body, headings
 *   at 1em (h1 1.08em) with line-height 1.25, inline code chips on muted/55.
 * - `thought`: the reasoning body (`.thought-markdown`), 12px muted.
 * - `code`: a fenced block body, `text-sm` at line-height 1.55.
 */
export function transcriptThemes(themeId: string) {
  const hit = cache.get(themeId)
  if (hit) return hit
  const syntax = syntaxTheme(themeId)
  const base: GpuixTheme = {
    appearance: 'dark',
    fontSans: SANS_FAMILY,
    fontMono: MONO_FAMILY,
    text: tokenColor('foreground'),
    textMuted: tokenColor('muted-foreground'),
    textFaint: tokenColor('muted-foreground'),
    textDim: tokenColor('muted-foreground'),
    accent: tokenColor('primary'),
    border: tokenColor('border/45'),
    bg: tokenColor('sidebar'),
    codeText: tokenColor('foreground'),
    codeWash: tokenColor('muted/55'),
    caret: tokenColor('foreground'),
    syntax
  }
  const themes = {
    prose: {
      ...base,
      metrics: {
        mdTextSize: PROSE_TEXT,
        mdLineHeight: PROSE_LINE,
        mdBlockGap: 4,
        mdHeadingSizes: [15.12, 14, 14, 14],
        mdHeadingLineHeights: [18.9, 17.5, 17.5, 17.5],
        mdTableCellPadding: 8,
        mdInlineCodeRadius: 4,
        mdCodePaddingX: 16,
        mdCodePaddingY: 16,
        mdCodeRadius: 6
      }
    },
    thought: {
      ...base,
      text: tokenColor('muted-foreground'),
      codeWash: tokenColor('muted/45'),
      metrics: {
        mdTextSize: 12,
        mdLineHeight: 16,
        mdBlockGap: 10.8,
        mdHeadingSizes: [12, 12, 12, 12],
        mdHeadingLineHeights: [16, 16, 16, 16],
        mdInlineCodeRadius: 3
      }
    },
    code: {
      ...base,
      metrics: { codeTextSize: PROSE_TEXT, codeLineHeight: 21.7 }
    }
  }
  cache.set(themeId, themes)
  return themes
}
