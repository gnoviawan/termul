import { render } from '@testing-library/react'
import { ToastProvider, ToastViewport } from './toast'

const { mobileRef } = vi.hoisted(() => ({
  // Mutable so the desktop/mobile rows can flip the shell without re-mocking.
  mobileRef: { current: false as boolean }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

// Story 11 (QA F9): the Radix toast viewport was `fixed top-0` full-width on
// mobile — colliding with the h-12 mobile shell header. On the mobile web
// shell it must anchor below the header (top-12); the desktop classes stay
// byte-identical (top-0 base, ≥sm bottom-right stacking).
describe('ToastViewport mobile positioning', () => {
  beforeEach(() => {
    mobileRef.current = false
  })

  afterEach(() => {
    mobileRef.current = false
  })

  it('anchors below the header (top-12) on the mobile web shell', () => {
    mobileRef.current = true
    const { container } = render(
      <ToastProvider>
        <ToastViewport />
      </ToastProvider>
    )

    // Radix renders the viewport itself as the <ol> (role=region wrapper
    // around it); the positioning classes live directly on the <ol>.
    const viewport = container.querySelector('ol') as HTMLElement
    expect(viewport).not.toBeNull()
    expect(viewport.className).toContain('top-12')
  })
  it('keeps the original top-0 / ≥sm bottom-right classes on desktop', () => {
    const { container } = render(
      <ToastProvider>
        <ToastViewport />
      </ToastProvider>
    )

    const viewport = container.querySelector('ol') as HTMLElement
    expect(viewport).not.toBeNull()
    expect(viewport.className).toContain('top-0')
    expect(viewport.className).toContain('sm:bottom-0')
    expect(viewport.className).toContain('sm:right-0')
    expect(viewport.className).not.toContain('top-12')
  })
})
