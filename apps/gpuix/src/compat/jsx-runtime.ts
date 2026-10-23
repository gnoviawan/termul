/**
 * The JSX runtime shared renderer code and bundled libraries compile
 * against (`build.ts` points their `react/jsx-runtime` here). DOM tags become
 * GPUIX elements; component types pass through untouched.
 */

import type { ReactElement } from 'react'
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime'
import { dropBlockWhitespace } from './children'
import { compatElement } from './container'
import type { DomProps } from './create'

type Props = Record<string, unknown>

export function jsx(type: unknown, props: Props, key?: string): ReactElement {
  if (typeof type === 'string') return compatElement(type, props as DomProps, key, false)
  if (type === Fragment) return reactJsx(Fragment, { ...props, children: dropBlockWhitespace(props.children) }, key)
  return reactJsx(type as never, props, key)
}

export function jsxs(type: unknown, props: Props, key?: string): ReactElement {
  if (typeof type === 'string') return compatElement(type, props as DomProps, key, true)
  if (type === Fragment) return reactJsxs(Fragment, { ...props, children: dropBlockWhitespace(props.children) }, key)
  return reactJsxs(type as never, props, key)
}

export function jsxDEV(type: unknown, props: Props, key: string | undefined, isStatic: boolean): ReactElement {
  return isStatic ? jsxs(type, props, key) : jsx(type, props, key)
}

export { Fragment }
