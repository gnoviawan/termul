/**
 * The `<Toaster />` of the sonner shim: the queue `toast(...)` publishes, as a
 * bottom-right stack in the overlay layer. Same visible cap, duration and
 * close button as `src/renderer/components/ui/sonner.tsx` sets on sonner.
 */

import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from '../compat/react-dom'
import { X } from '../icons'
import { Box } from '../ui/internal/host'
import { subscribeToasts, type ToastRecord } from './sonner'

export interface ToasterProps {
  visibleToasts?: number
  duration?: number
  closeButton?: boolean
  [prop: string]: unknown
}

const KIND_CLASS: Record<ToastRecord['kind'], string> = {
  default: 'text-foreground',
  success: 'text-success',
  error: 'text-destructive',
  info: 'text-foreground',
  warning: 'text-warning',
  loading: 'text-muted-foreground'
}

export function Toaster({ visibleToasts = 3, duration = 4000, closeButton = false }: ToasterProps): ReactNode {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  useEffect(
    () =>
      subscribeToasts((event) => {
        if (event.type === 'dismiss') {
          setToasts((list) => (event.id === undefined ? [] : list.filter((t) => t.id !== event.id)))
          return
        }
        setToasts((list) => [...list.filter((t) => t.id !== event.toast.id), event.toast])
      }),
    []
  )
  useEffect(() => {
    const timers = toasts
      .filter((t) => t.kind !== 'loading' && t.duration !== Number.POSITIVE_INFINITY)
      .map((t) =>
        setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), t.duration ?? duration)
      )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [toasts, duration])

  if (toasts.length === 0) return null
  return createPortal(
    <Box data-testid="toaster" className="absolute bottom-5 right-5 flex w-[356px] flex-col gap-2">
      {toasts.slice(-visibleToasts).map((t) => (
        <Box
          key={t.id}
          data-testid="toast"
          className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-sm shadow-lg"
        >
          <Box className="flex flex-1 flex-col gap-1">
            <Box className={`font-medium ${KIND_CLASS[t.kind]}`}>{t.message}</Box>
            {t.description ? <Box className="text-muted-foreground">{t.description}</Box> : null}
          </Box>
          {closeButton ? (
            <Box
              aria-label="Close toast"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
            >
              <X className="size-3.5" />
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>,
    null
  )
}
