import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCK_CLEARANCE_VAR } from '@/hooks/use-dock-clearance'
import { Toaster } from './sonner'

const { mobileRef, sonnerPropsRef } = vi.hoisted(() => ({
  // Mutable so the desktop/mobile rows can flip the shell without re-mocking.
  mobileRef: { current: false as boolean },
  // Captures the props the Toaster passes to sonner's <Toaster> so the
  // mobile expand/offset behavior is assertable from the props alone.
  sonnerPropsRef: { current: null as Record<string, unknown> | null }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

// Wrap sonner's <Toaster>: capture the props it receives (the prop rows below)
// and still render the real component (the join test at the end, which needs
// sonner's own list element). `toast` stays the real one for the same reason.
vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>()
  return {
    ...actual,
    Toaster: (props: Record<string, unknown>) => {
      sonnerPropsRef.current = props
      return <actual.Toaster {...props} />
    }
  }
})

// Story 11 (QA F9): sonner's stack expansion is hover-driven — on touch
// `expand={false}` left queued toasts permanently hidden behind the front
// toast over the terminal key bar. On the mobile web shell the stack must
// default to expanded and the offset must clear the key bar; desktop keeps
// the collapsed hover-expand pile (expand=false, offset 20).
// The mobile offset is not a constant: it follows the dock that
// `useDockClearance` measures (`--mobile-dock-height`), one 12px gap above it.
describe('Sonner Toaster mobile expansion + offset', () => {
  beforeEach(() => {
    mobileRef.current = false
    sonnerPropsRef.current = null
  })

  afterEach(() => {
    mobileRef.current = false
  })

  it('expands the stack and lifts both offsets 12px above the measured dock on mobile', () => {
    mobileRef.current = true
    render(<Toaster />)

    const props = sonnerPropsRef.current!
    expect(props.expand).toBe(true)
    // sonner 1.7.4 uses `offset` above 600px and `mobileOffset` at 600px and
    // below, so a portrait phone only sees the latter. The object form moves
    // just the bottom edge (a number or string would also squeeze left and
    // right). The variable is the distance from the viewport bottom to the
    // highest dock edge; the fallback keeps `bottom` valid while no dock is
    // mounted (editor, Git, browser tab) and sits one gap above the inset.
    const bottom = 'calc(var(--mobile-dock-height, env(safe-area-inset-bottom, 0px)) + 12px)'
    expect(props.offset).toEqual({ bottom })
    expect(props.mobileOffset).toEqual({ bottom })
  })

  it('keeps the collapsed hover-expand pile and edge offset on desktop', () => {
    render(<Toaster />)

    const props = sonnerPropsRef.current!
    expect(props.expand).toBe(false)
    expect(props.offset).toBe(20)
    expect(props.mobileOffset).toBeUndefined()
  })

  it('follows Termul appearance and paints a card, not a rich-color wash', () => {
    render(<Toaster />)

    const props = sonnerPropsRef.current!
    expect(props.theme).toBe('dark')
    expect(props.richColors).toBeFalsy()
    const options = props.toastOptions as { classNames: { toast: string; description: string } }
    expect(options.classNames.toast).toContain('bg-card')
    expect(options.classNames.toast).toContain('border-border')
    expect(options.classNames.description).toContain('text-muted-foreground')

    const css = readFileSync(join(process.cwd(), 'src/renderer/components/ui/sonner.css'), 'utf8')
    expect(css).toContain('oklch(var(--card))')
    expect(css).toContain('data-type="info"')
    expect(css).toContain('oklch(var(--muted-foreground))')
    expect(css).toContain('oklch(var(--success))')
    expect(css).toContain('oklch(var(--warning))')
    expect(css).toContain('oklch(var(--destructive))')
    expect(css).toContain('box-shadow: none')
    expect(css).toContain('html.dark')
    expect(css).not.toMatch(/#fff|#3b82f6|#0f1011/)
  })
})

// The prop rows above only prove what the Toaster hands to sonner. This one
// proves sonner turns the string offset into the inline CSS variables that the
// stylesheet reads (`bottom: var(--offset-bottom)`, and
// `var(--mobile-offset-bottom)` at 600px and below), so the `env()` fallback
// reaches the page. The variable is undefined while no dock is registered, and
// only the fallback keeps `bottom` valid then.
describe('Sonner Toaster mobile offset reaches the toast list', () => {
  beforeEach(() => {
    mobileRef.current = true
    sonnerPropsRef.current = null
  })

  afterEach(() => {
    act(() => {
      toast.dismiss()
    })
    mobileRef.current = false
  })

  it('writes the dock-clearance calc to --offset-bottom and --mobile-offset-bottom', async () => {
    const { container } = render(<Toaster />)

    act(() => {
      toast('Clipboard read failed')
    })

    // sonner flushes a new toast into its list from a timeout, not synchronously.
    await waitFor(() => {
      expect(container.querySelector('[data-sonner-toaster]')).not.toBeNull()
    })
    const list = container.querySelector<HTMLElement>('[data-sonner-toaster]')
    const bottom = `calc(var(${DOCK_CLEARANCE_VAR}, env(safe-area-inset-bottom, 0px)) + 12px)`
    expect(list?.style.getPropertyValue('--offset-bottom')).toBe(bottom)
    expect(list?.style.getPropertyValue('--mobile-offset-bottom')).toBe(bottom)
  })
})
