/**
 * `sonner` for the GPUIX client. The real package injects a stylesheet into
 * `document.head` on import and renders DOM, neither of which exists here.
 * Shared code only calls `toast(...)`, so this keeps that call surface and
 * records every toast in an observable queue a native toaster will render.
 */

import type { ExternalToast } from 'sonner'

export type ToastKind = 'default' | 'success' | 'error' | 'info' | 'warning' | 'loading'

export interface ToastRecord {
  id: string | number
  kind: ToastKind
  message: string
  description?: string
}

type Listener = (toast: ToastRecord) => void

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
  for (const listener of listeners) listener(record)
  return id
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
  dismiss: (_id?: string | number) => undefined,
  promise: <T>(promise: Promise<T> | (() => Promise<T>), _opts?: unknown) =>
    typeof promise === 'function' ? promise() : promise
})
