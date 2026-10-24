/**
 * `sonner` for the GPUIX client. The real package injects a stylesheet into
 * `document.head` on import and renders DOM, neither of which exists here.
 * Shared code calls `toast(...)` and mounts `<Toaster />`; this keeps that
 * call surface (1.7: kinds, `id` updates in place, `action` / `cancel`,
 * `duration`, `classNames`, `onDismiss` / `onAutoClose`, `promise`) and
 * publishes every toast to the native toaster in `toaster.tsx`.
 */

import type { ExternalToast } from 'sonner'

export type ToastKind = 'default' | 'success' | 'error' | 'info' | 'warning' | 'loading'

export interface ToastButton {
  label: string
  onClick: (event: unknown) => void
}

export interface ToastClassNames {
  toast?: string
  title?: string
  description?: string
  content?: string
  actionButton?: string
  cancelButton?: string
}

export interface ToastRecord {
  id: string | number
  kind: ToastKind
  message: string
  description?: string
  duration?: number
  action?: ToastButton
  cancel?: ToastButton
  classNames?: ToastClassNames
  onDismiss?: (toast: ToastRecord) => void
  onAutoClose?: (toast: ToastRecord) => void
}

export type ToastEvent =
  | { type: 'show'; toast: ToastRecord }
  | { type: 'dismiss'; id?: string | number }

type Listener = (event: ToastEvent) => void

const listeners = new Set<Listener>()
let nextId = 1

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** sonner takes `{ label, onClick }` or a React node; only the object form has a native rendering. */
function button(value: unknown): ToastButton | undefined {
  if (!value || typeof value !== 'object' || !('label' in value) || !('onClick' in value))
    return undefined
  const { label, onClick } = value as { label: unknown; onClick: unknown }
  return typeof onClick === 'function'
    ? { label: text(label), onClick: onClick as ToastButton['onClick'] }
    : undefined
}

function publish(kind: ToastKind, message: unknown, opts?: ExternalToast): string | number {
  const id = opts?.id ?? nextId++
  const record: ToastRecord = { id, kind, message: text(message) }
  const description = opts?.description
  if (typeof description === 'string') record.description = description
  if (typeof opts?.duration === 'number') record.duration = opts.duration
  const action = button(opts?.action)
  if (action) record.action = action
  const cancel = button(opts?.cancel)
  if (cancel) record.cancel = cancel
  if (opts?.classNames) record.classNames = opts.classNames as ToastClassNames
  if (opts?.onDismiss) record.onDismiss = opts.onDismiss as unknown as ToastRecord['onDismiss']
  if (opts?.onAutoClose)
    record.onAutoClose = opts.onAutoClose as unknown as ToastRecord['onAutoClose']
  emit({ type: 'show', toast: record })
  return id
}

function emit(event: ToastEvent): void {
  for (const listener of listeners) listener(event)
}

type PromiseMessage<T> = string | ((value: T) => unknown)

interface PromiseData<T> extends Omit<ExternalToast, 'id'> {
  id?: string | number
  loading?: string
  success?: PromiseMessage<T>
  error?: PromiseMessage<unknown>
  finally?: () => void
}

function resolveMessage<T>(message: PromiseMessage<T> | undefined, value: T): unknown {
  return typeof message === 'function' ? message(value) : message
}

/** One toast that shows `loading`, then turns into `success` or `error` in place. */
function promiseToast<T>(
  promise: Promise<T> | (() => Promise<T>),
  data: PromiseData<T> = {}
): string | number {
  const { loading, success, error, finally: onFinally, ...opts } = data
  const id = opts.id ?? nextId++
  if (loading !== undefined) publish('loading', loading, { ...opts, id })
  const running = typeof promise === 'function' ? promise() : promise
  running.then(
    (value) => {
      if (success !== undefined) publish('success', resolveMessage(success, value), { ...opts, id })
      else emit({ type: 'dismiss', id })
    },
    (reason: unknown) => {
      if (error !== undefined) publish('error', resolveMessage(error, reason), { ...opts, id })
      else emit({ type: 'dismiss', id })
    }
  )
  if (onFinally) void running.finally(onFinally).catch(() => {})
  return id
}

function toastFn(message: unknown, opts?: ExternalToast): string | number {
  return publish('default', message, opts)
}

export const toast = Object.assign(toastFn, {
  message: (message: unknown, opts?: ExternalToast) => publish('default', message, opts),
  success: (message: unknown, opts?: ExternalToast) => publish('success', message, opts),
  error: (message: unknown, opts?: ExternalToast) => publish('error', message, opts),
  info: (message: unknown, opts?: ExternalToast) => publish('info', message, opts),
  warning: (message: unknown, opts?: ExternalToast) => publish('warning', message, opts),
  loading: (message: unknown, opts?: ExternalToast) => publish('loading', message, opts),
  dismiss: (id?: string | number) => emit({ type: 'dismiss', id }),
  promise: promiseToast
})

export { Toaster } from './toaster'
