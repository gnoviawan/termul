import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from './sonner'

const { mobileRef, sonnerPropsRef } = vi.hoisted(() => ({
  // Mutable so the desktop/mobile rows can flip the shell without re-mocking.
  mobileRef: { current: false as boolean },
  // Captures the props the Toaster passes to sonner's <Toaster> so the
  // mobile expand/offset behavior is assertable without rendering sonner's
  // real portal chrome.
  sonnerPropsRef: { current: null as Record<string, unknown> | null }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

// Stub sonner itself: the module also exports `toast` used across the app —
// re-export a inert stand-in so the mock surface stays compatible.
vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    sonnerPropsRef.current = props
    return null
  },
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn()
  })
}))

// Story 11 (QA F9): sonner's stack expansion is hover-driven — on touch
// `expand={false}` left queued toasts permanently hidden behind the front
// toast over the terminal key bar. On the mobile web shell the stack must
// default to expanded and the offset must clear the key bar; desktop keeps
// the collapsed hover-expand pile (expand=false, offset 20).
describe('Sonner Toaster mobile expansion + offset', () => {
  beforeEach(() => {
    mobileRef.current = false
    sonnerPropsRef.current = null
  })

  afterEach(() => {
    mobileRef.current = false
  })

  it('expands the stack and lifts the offset clear of the key bar on mobile', () => {
    mobileRef.current = true
    render(<Toaster />)

    const props = sonnerPropsRef.current!
    expect(props.expand).toBe(true)
    expect(props.offset).toBe(88)
  })

  it('keeps the collapsed hover-expand pile and edge offset on desktop', () => {
    render(<Toaster />)

    const props = sonnerPropsRef.current!
    expect(props.expand).toBe(false)
    expect(props.offset).toBe(20)
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
    expect(css).not.toMatch(/#fff|#3b82f6/)
  })
})
