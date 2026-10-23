/**
 * `react` for shared code and bundled libraries: the real module, with
 * `createElement` routed through the compat runtime (hugeicons and
 * react-markdown call it with DOM tags) and `cloneElement` re-translating a
 * compat element from its DOM props.
 *
 * The names are listed: `export * from` an external CommonJS module throws a
 * ReferenceError under Bun 1.4's bundler (measured in X1).
 */

import * as React from 'react'
import type { ReactElement } from 'react'
import { createDomElement, type DomProps, domSource } from './create'
import { hostElement } from './host'

type Props = Record<string, unknown> | null

function withChildren(props: Props, children: unknown[]): { props: Record<string, unknown>; isStatic: boolean } {
  const out: Record<string, unknown> = { ...(props ?? {}) }
  delete out.key
  if (children.length === 1) out.children = children[0]
  else if (children.length > 1) out.children = children
  return { props: out, isStatic: children.length > 1 }
}

export function createElement(type: unknown, props: Props, ...children: unknown[]): ReactElement {
  if (typeof type !== 'string') return React.createElement(type as never, props as never, ...(children as never[]))
  const { props: merged, isStatic } = withChildren(props, children)
  const key = props?.key === undefined || props.key === null ? undefined : String(props.key)
  return createDomElement(type, merged as DomProps, key, isStatic, hostElement)
}

export function cloneElement(element: ReactElement, props?: Props, ...children: unknown[]): ReactElement {
  const source = domSource.get(element)
  if (!source) return React.cloneElement(element, props as never, ...(children as never[]))
  const merged: Record<string, unknown> = { ...source.props, ...(props ?? {}) }
  delete merged.key
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  const key = props?.key === undefined ? source.key : String(props.key)
  const isStatic = Array.isArray(merged.children) && children.length > 1
  return createDomElement(source.tag, merged as DomProps, key, isStatic, hostElement)
}

export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cache,
  createContext,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version
} = React

export const __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = (
  React as unknown as Record<string, unknown>
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

const compatReact = { ...React, createElement, cloneElement }
export default compatReact
