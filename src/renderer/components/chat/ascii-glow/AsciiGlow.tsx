import { useEffect, useRef } from 'react'
import { useEffectiveColorThemeId } from '@/hooks/use-color-theme'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { type AsciiGlowHandle, createAsciiGlow, WebGpuUnavailableError } from './create-ascii-glow'

/** Glyph alpha: the glow stays a quiet texture under the start screen. */
const GLOW_OPACITY = 0.07

let reportedUnavailable = false

/**
 * The chat start backdrop: a slow, monochrome ASCII glow drawn with WebGPU
 * in the foreground colour at a low alpha. Where WebGPU is missing (Linux
 * WebKitGTK, older WebKit) the canvas stays empty. Decorative only: hidden
 * from assistive tech and never takes pointer events.
 */
export function AsciiGlow({ className }: { className?: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<AsciiGlowHandle | null>(null)
  const themeId = useEffectiveColorThemeId()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const controller = new AbortController()
    const report = (error: Error, level: 'info' | 'warn'): void => {
      void logFrontendError({
        level,
        message: error.message,
        source: 'AsciiGlow',
        stack: error.stack
      })
    }
    createAsciiGlow(canvas, {
      opacity: GLOW_OPACITY,
      signal: controller.signal,
      onError: (error) => report(error, 'warn')
    })
      .then((handle) => {
        if (controller.signal.aborted) handle.destroy()
        else handleRef.current = handle
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const failure = error instanceof Error ? error : new Error(String(error))
        if (!(failure instanceof WebGpuUnavailableError)) return report(failure, 'warn')
        // A missing WebGPU is expected on some webviews: say it once, quietly.
        if (reportedUnavailable) return
        reportedUnavailable = true
        report(failure, 'info')
      })
    return () => {
      controller.abort()
      handleRef.current?.destroy()
      handleRef.current = null
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: themeId is the trigger; the ink is read from the canvas's computed colour
  useEffect(() => {
    // The theme's CSS variables apply in an effect too: read after paint.
    const frame = requestAnimationFrame(() => handleRef.current?.refreshInk())
    return () => cancelAnimationFrame(frame)
  }, [themeId])

  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 text-foreground', className)}
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  )
}
