/**
 * The font size and line height an element inherits, as CSS inherits them.
 * Tailwind's `text-xs` sets a unitless line height (`calc(1 / 0.75)`), so a
 * child that sets only a size (`text-3xs`) gets that ratio times its own
 * size, and a child that sets only a ratio (`leading-none`) gets it times the
 * inherited size. A GPUIX line height is px and a class string is translated
 * alone, so an element that declares both provides them here, and an element
 * that declares one half renders through `FontHost`, which reads the other
 * half and resolves its line height.
 */

import type { StyleDesc } from '@gpuix/react'
import { createContext, type ReactElement, useContext, useMemo } from 'react'
import { jsx } from 'react/jsx-runtime'
import { INHERITED_LEADING, ROOT_FONT_SIZE } from '../style/scale'
import type { OwnFont } from '../style/tw'
import type { Leading } from '../style/utilities'
import { childInfo } from './children'
import type { DomProps } from './create'
import type { Translation } from './translate'

export interface InheritedFont {
  size: number
  leading: Leading
}

/** `html`: 16 px, and Tailwind preflight's `line-height: 1.5`. */
export const FontContext = createContext<InheritedFont>({
  size: ROOT_FONT_SIZE,
  leading: { ratio: INHERITED_LEADING }
})

export function lineHeightOf(font: InheritedFont): number {
  const px = 'px' in font.leading ? font.leading.px : font.leading.ratio * font.size
  return Math.round(px * 100) / 100
}

/** Both halves declared: the font this element's descendants inherit. */
export function completeFont(own: OwnFont | undefined): InheritedFont | null {
  return own?.size !== undefined && own.leading ? { size: own.size, leading: own.leading } : null
}

/**
 * One half declared, on an element that is a box of its own. An inline
 * element that paints nothing becomes a run of its parent's text, whose
 * line height the parent sets, so it keeps its translated style.
 */
export function inheritsFont(tr: Translation, props: DomProps): boolean {
  const own = tr.compiled.font
  if (!own || tr.fontScope || (tr.inline && !tr.paints)) return false
  if (tr.autoMargin || tr.placement || tr.fixed || tr.fillMinus !== null) return false
  return props.style?.lineHeight === undefined
}

export type BuildWithFont = (style: StyleDesc) => ReactElement

interface FontHostProps {
  own: OwnFont
  build: BuildWithFont
}

function FontHost({ own, build }: FontHostProps): ReactElement {
  const parent = useContext(FontContext)
  const font = useMemo(
    () => ({ size: own.size ?? parent.size, leading: own.leading ?? parent.leading }),
    [own, parent]
  )
  return jsx(FontContext.Provider, {
    value: font,
    children: build({ lineHeight: lineHeightOf(font) })
  })
}

/** `build` runs with the resolved line height, under the font it provides. */
export function fontHostElement(
  tr: Translation,
  key: string | undefined,
  build: BuildWithFont
): ReactElement {
  const element = jsx(FontHost, { own: tr.compiled.font as OwnFont, build }, key)
  childInfo.set(element, { inline: tr.inline })
  return element
}
