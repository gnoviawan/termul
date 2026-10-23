/**
 * What the window shows about its termul-server. Before the first `ready` it
 * is the whole window (starting, or the failure with a Retry button). After
 * that the app stays mounted and a banner across the top reports a crash, the
 * restart, or a failure; the renderer's own sockets reconnect when the server
 * is back on the same origin.
 */

import { useGpuixRequired } from '@gpuix/react'
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '../ui/button'
import { Box } from '../ui/internal/host'
import { Spinner } from '../ui/spinner'
import { describeFailure, type ServerPhase, type ServerStatus } from './status'

export interface ServerGateProps {
  status: ServerStatus
  onFocusRequest(listener: () => void): void
  /** Runs once, on the first `ready`, before the children mount. Must be stable. */
  onFirstReady(): void
  children: ReactNode
}

function bannerText(phase: ServerPhase): string | null {
  switch (phase.kind) {
    case 'crashed':
      return `Termul server stopped (${phase.detail}). Restarting…`
    case 'starting':
      return phase.after
        ? `Termul server stopped (${phase.after}). Restarting…`
        : 'Restarting Termul server…'
    case 'failed':
      return describeFailure(phase.failure)
    case 'ready':
    case 'stopped':
      return null
  }
}

function FullWindow({ phase, onRetry }: { phase: ServerPhase; onRetry(): void }) {
  if (phase.kind === 'failed') {
    return (
      <Box
        data-testid="server-status-error"
        className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background px-8 text-foreground"
      >
        <Box className="text-base font-semibold">Termul could not start its server</Box>
        <Box className="max-w-xl text-center text-sm text-muted-foreground">
          {describeFailure(phase.failure)}
        </Box>
        <Button data-testid="server-retry" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </Box>
    )
  }
  return (
    <Box
      data-testid="server-status-starting"
      className="flex h-full w-full items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
    >
      <Spinner />
      Starting Termul server…
    </Box>
  )
}

function Banner({ phase, onRetry }: { phase: ServerPhase; onRetry(): void }) {
  const text = bannerText(phase)
  if (!text) return null
  const failed = phase.kind === 'failed'
  return (
    <Box
      data-testid={failed ? 'server-status-error' : 'server-status-crashed'}
      className="absolute left-0 right-0 top-0 flex h-10 items-center gap-3 border-b border-border bg-card px-4 text-sm text-foreground"
    >
      {failed ? null : <Spinner />}
      <Box className={failed ? 'flex-1 text-destructive' : 'flex-1'}>{text}</Box>
      {failed ? (
        <Button data-testid="server-retry" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </Box>
  )
}

export function ServerGate({ status, onFocusRequest, onFirstReady, children }: ServerGateProps) {
  const phase = useSyncExternalStore(status.subscribe, status.get)
  const renderer = useGpuixRequired()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (phase.kind !== 'ready' || mounted) return
    onFirstReady()
    setMounted(true)
  }, [phase.kind, mounted, onFirstReady])
  useEffect(() => {
    onFocusRequest(() => renderer.activateWindow?.())
  }, [onFocusRequest, renderer])

  if (!mounted) return <FullWindow phase={phase} onRetry={status.retry} />
  return (
    <Box className="relative flex h-full w-full">
      {children}
      <Banner phase={phase} onRetry={status.retry} />
    </Box>
  )
}
