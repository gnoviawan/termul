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

/**
 * `.chat-streamdown` inline-code chip: 0.88em glyphs, `padding: 0.08em 0.3em`,
 * radius 0.25rem. The 0.3em (3.7px at 12.32px) is laid out on both sides of
 * the chip and pushes its neighbours as CSS does (patches zed/0004 and
 * gpuix/0007). The 0.08em top and bottom on Paper Mono's 1.2em content box
 * leave about 2px of the 21px line above and below.
 */
const PROSE_CHIP = {
  mdInlineCodeRadius: 4,
  mdInlineCodeScale: 0.88,
  mdInlineCodePaddingX: 3.7,
  mdInlineCodeInsetY: 2
}

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

const cache = new Map<
  string,
  {
    prose: GpuixTheme
    tableFullscreen: GpuixTheme
    quote: GpuixTheme
    thought: GpuixTheme
    code: GpuixTheme
  }
>()

/**
 * - `prose`: an agent reply block (`.chat-streamdown`): 14/21 body, inline
 *   code chips on muted/55 at 0.88em with 0.3em side padding (index.css),
 *   links medium in primary (`LINK_CLASS` in chat-agent-prose.tsx). Link
 *   colour and weight, the chip's size and padding, and the italic quote
 *   need the patched addon (patch 0002); the published one keeps body-size
 *   chips, text-coloured links and upright quotes. Headings take
 *   Streamdown's utility sizes (`text-3xl` .. `text-lg`): utilities beat
 *   index.css's components layer. Table rules are Streamdown's
 *   `divide-y divide-border`: under the header and between body rows.
 *   Native markdown tints list markers and the quote rail with `accent`; the
 *   web's markers are the text colour, so accent is the foreground.
 * - `tableFullscreen`: the table in the fullscreen view, which the web
 *   portals outside `.chat-streamdown`, so Streamdown's utilities apply
 *   unscaled: cells `px-4 py-2` (16 by 8 px) on a 20px line, a `bg-muted/80`
 *   header, and inline code `rounded bg-muted px-1.5 py-0.5 font-mono
 *   text-sm` (14px glyphs, 6px side padding, the wash the full line tall).
 *   The table has no `divide-y`, so only the body rows are ruled (`tbody`'s
 *   `divide-border`), with no rule under the header. Measured by
 *   `tools/chat/table-probe.ts`.
 * - `quote`: a quote's content, muted and italic like Streamdown's
 *   `text-muted-foreground italic`.
 * - `thought`: the reasoning body (`.thought-markdown`), 12px muted.
 * - `code`: a fenced block body. Shiki's `<pre>` paints 13px mono at 20px
 *   rows (measured in Chromium; the 1.55 line-height applies to the body div).
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
    accent: tokenColor('foreground'),
    border: tokenColor('border/45'),
    bg: tokenColor('sidebar'),
    codeText: tokenColor('foreground'),
    codeWash: tokenColor('muted/55'),
    link: tokenColor('primary'),
    linkUnderline: tokenColor('primary'),
    linkWeight: 500,
    caret: tokenColor('foreground'),
    syntax
  }
  const themes = {
    prose: {
      ...base,
      // `thead` is `bg-muted/80` and each `th` adds `bg-muted/35`: muted at 87%.
      tableHeaderBg: tokenColor('muted/87'),
      tableRule: tokenColor('border'),
      metrics: {
        mdTextSize: PROSE_TEXT,
        mdLineHeight: PROSE_LINE,
        mdBlockGap: 4,
        mdHeadingSizes: [30, 24, 20, 18],
        mdHeadingLineHeights: [36, 32, 28, 28],
        // Streamdown cells: `px-4 py-2` under `.chat-streamdown` comes out at
        // 8px by 4.8px, `text-sm` on a 20px line, semibold header.
        mdTableCellPadding: 8,
        mdTableCellPaddingY: 4.8,
        mdTableLineHeight: 20,
        mdTableHeaderWeight: 600,
        ...PROSE_CHIP,
        mdCodePaddingX: 16,
        mdCodePaddingY: 16,
        mdCodeRadius: 6
      }
    },
    tableFullscreen: {
      ...base,
      codeWash: tokenColor('muted'),
      tableHeaderBg: tokenColor('muted/80'),
      tableRule: tokenColor('border'),
      metrics: {
        mdTextSize: PROSE_TEXT,
        mdLineHeight: 20,
        mdBlockGap: 4,
        mdTableCellPadding: 16,
        mdTableCellPaddingY: 8,
        mdTableLineHeight: 20,
        mdTableHeaderWeight: 600,
        mdTableHeaderRule: 0,
        mdInlineCodeRadius: 4,
        mdInlineCodeScale: 1,
        mdInlineCodePaddingX: 6,
        mdInlineCodeInsetY: 0
      }
    },
    quote: {
      ...base,
      text: tokenColor('muted-foreground'),
      fontStyle: 'italic' as const,
      metrics: {
        mdTextSize: PROSE_TEXT,
        mdLineHeight: PROSE_LINE,
        mdBlockGap: 4,
        ...PROSE_CHIP
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
        // `.thought-markdown` chip: 0.85em, padding 0 0.22em, radius 0.2rem.
        mdInlineCodeRadius: 3,
        mdInlineCodeScale: 0.85,
        mdInlineCodePaddingX: 2.2,
        mdInlineCodeInsetY: 2
      }
    },
    code: {
      ...base,
      metrics: { codeTextSize: 13, codeLineHeight: 20 }
    }
  }
  cache.set(themeId, themes)
  return themes
}
