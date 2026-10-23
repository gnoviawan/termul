/**
 * `sonner` for the GPUIX client. The real package injects a stylesheet into
 * `document.head` on import and renders DOM, neither of which exists here.
 * Shared code calls `toast(...)` and mounts `<Toaster />`; this keeps that
 * call surface and publishes every toast to the native toaster in
 * `toaster.tsx`.
 */

import type { ExternalToast } from 'sonner'

export type ToastKind = 'default' | 'success' | 'error' | 'info' | 'warning' | 'loading'

export interface ToastRecord {
  id: string | number
  kind: ToastKind
  message: string
  description?: string
  duration?: number
}

export type ToastEvent = { type: 'show'; toast: ToastRecord } | { type: 'dismiss'; id?: string | number }

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

function publish(kind: ToastKind, message: unknown, opts?: ExternalToast): string | number {
  const id = opts?.id ?? nextId++
  const record: ToastRecord = { id, kind, message: text(message) }
  const description = opts?.description
  if (typeof description === 'string') record.description = description
  if (typeof opts?.duration === 'number') record.duration = opts.duration
  emit({ type: 'show', toast: record })
  return id
}

function emit(event: ToastEvent): void {
  for (const listener of listeners) listener(event)
}

function toastFn(message: unknown, opts?: ExternalToast): string | number {
  return publish('default', message, opts)
}

export const toast = Object.assign(toastFn, {
  success: (message: unknown, opts?: ExternalToast) => publish('success', message, opts),
  error: (message: unknown, opts?: ExternalToast) => publish('error', message, opts),
  info: (message: unknown, opts?: ExternalToast) => publish('info', message, opts),
  warning: (message: unknown, opts?: ExternalToast) => publish('warning', message, opts),
  loading: (message: unknown, opts?: ExternalToast) => publish('loading', message, opts),
  dismiss: (id?: string | number) => emit({ type: 'dismiss', id }),
  promise: <T>(promise: Promise<T> | (() => Promise<T>), _opts?: unknown) =>
    typeof promise === 'function' ? promise() : promise
})

export { Toaster } from './toaster'
