import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateSnapshotModal } from '@/components/CreateSnapshotModal'
import { useOverlayRegistration, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { isInertExemptOverlay, useInertBehindOverlays } from './use-inert-behind-overlays'

function Body({ detached = false }: { detached?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useInertBehindOverlays(ref)
  return (
    <div>
      <div role="status" data-testid="outside" />
      <div ref={detached ? undefined : ref} data-testid="body">
        <button type="button">inside</button>
      </div>
    </div>
  )
}

function register(id: string): void {
  act(() => {
    useOverlayStackStore.getState().registerOverlay(id, () => {})
  })
}

function unregister(id: string): void {
  act(() => {
    useOverlayStackStore.getState().unregisterOverlay(id)
  })
}

function bodyEl(): HTMLElement {
  return screen.getByTestId('body')
}

describe('isInertExemptOverlay', () => {
  it.each([
    'agent-launcher',
    'confirm-dialog:r1',
    'confirm-dialog::r2:',
    'message-actions-menu:m-1',
    'create-snapshot-modal::r3:',
    'new-project-modal::r4:'
  ])('exempts %s', (id) => {
    expect(isInertExemptOverlay(id)).toBe(true)
  })

  it.each([
    'mobile-drawer',
    'projects-sheet',
    'files-sheet',
    'header-more-sheet',
    'terminal-actions-sheet',
    'mobile-file-actions',
    'git-sheet',
    'command-palette',
    'settings-modal',
    'command-history',
    'theme-picker',
    'ssh-password-prompt',
    'composer-add-sheet',
    'context-details-sheet',
    'agent-model-selector:abc',
    'dialog:x',
    'alert-dialog:x',
    'image-lightbox:x',
    // Prefixes match whole ids only: look-alikes are blocking.
    'agent-launcher-2',
    'confirm-dialog',
    'message-actions-menu',
    'create-snapshot-modal',
    'new-project-modal',
    'directory-picker'
  ])('blocks on %s', (id) => {
    expect(isInertExemptOverlay(id)).toBe(false)
  })
})

describe('useInertBehindOverlays', () => {
  beforeEach(() => {
    useOverlayStackStore.setState({ stack: [] })
  })

  afterEach(() => {
    useOverlayStackStore.setState({ stack: [] })
  })

  it('leaves the body interactive while no overlay is open', () => {
    render(<Body />)
    expect(bodyEl()).not.toHaveAttribute('inert')
  })

  it('sets inert for a blocking overlay and removes it when the last one closes', () => {
    render(<Body />)

    register('files-sheet')
    expect(bodyEl().getAttribute('inert')).toBe('')
    expect(screen.getByTestId('outside')).not.toHaveAttribute('inert')

    register('mobile-file-actions')
    expect(bodyEl()).toHaveAttribute('inert')

    unregister('files-sheet')
    expect(bodyEl()).toHaveAttribute('inert')

    unregister('mobile-file-actions')
    expect(bodyEl()).not.toHaveAttribute('inert')
  })

  it.each([
    'agent-launcher',
    'confirm-dialog:r1',
    'message-actions-menu:m-1',
    'create-snapshot-modal:r3',
    'new-project-modal:r4'
  ])('does not set inert when only %s is open', (id) => {
    render(<Body />)

    register(id)
    expect(bodyEl()).not.toHaveAttribute('inert')

    unregister(id)
    expect(bodyEl()).not.toHaveAttribute('inert')
  })

  it('stays inert while an exempt and a blocking overlay are mixed, until the blocking one closes', () => {
    render(<Body />)

    register('agent-launcher')
    expect(bodyEl()).not.toHaveAttribute('inert')

    register('files-sheet')
    expect(bodyEl()).toHaveAttribute('inert')

    unregister('agent-launcher')
    expect(bodyEl()).toHaveAttribute('inert')

    register('confirm-dialog:r1')
    unregister('files-sheet')
    expect(bodyEl()).not.toHaveAttribute('inert')
  })

  it('applies at once on mount when a blocking overlay is already open', () => {
    useOverlayStackStore.setState({ stack: [{ id: 'files-sheet', close: () => {} }] })
    render(<Body />)
    expect(bodyEl()).toHaveAttribute('inert')
  })

  it('releases the subscription and clears the attribute on unmount', () => {
    const view = render(<Body />)
    register('files-sheet')
    const element = bodyEl()
    expect(element).toHaveAttribute('inert')

    view.unmount()
    expect(element).not.toHaveAttribute('inert')

    // The detached element is no longer driven by the store.
    register('git-sheet')
    expect(element).not.toHaveAttribute('inert')
  })

  it('does nothing while the ref is null', () => {
    render(<Body detached />)
    expect(() => register('files-sheet')).not.toThrow()
    expect(bodyEl()).not.toHaveAttribute('inert')
  })

  it('does not re-render the host on a stack change', () => {
    let renders = 0
    function Counting(): React.JSX.Element {
      renders += 1
      const ref = useRef<HTMLDivElement>(null)
      useInertBehindOverlays(ref)
      return <div ref={ref} data-testid="body" />
    }
    render(<Counting />)
    const before = renders

    register('files-sheet')
    unregister('files-sheet')

    expect(renders).toBe(before)
  })

  describe('a modal rendered inside the body', () => {
    afterEach(() => {
      useOverlayStackStore.setState({ stack: [], mobileShell: false })
    })

    it('stays interactive: the Snapshots page modal registers an exempt id and its subtree is not inert', () => {
      // The mobile shell body holds the routed page, so CreateSnapshotModal (a
      // `fixed inset-0` div, not a portal) is a DOM descendant of the wrapper.
      useOverlayStackStore.setState({ stack: [], mobileShell: true })
      function Page(): React.JSX.Element {
        const ref = useRef<HTMLDivElement>(null)
        useInertBehindOverlays(ref)
        return (
          <div ref={ref} data-testid="body">
            <CreateSnapshotModal isOpen onClose={() => {}} onCreateSnapshot={() => {}} />
          </div>
        )
      }
      render(<Page />)

      const ids = useOverlayStackStore.getState().stack.map((entry) => entry.id)
      expect(ids).toHaveLength(1)
      expect(isInertExemptOverlay(ids[0])).toBe(true)
      expect(bodyEl()).not.toHaveAttribute('inert')
      expect(screen.getByText('Create Snapshot').closest('[inert]')).toBeNull()
    })
  })

  describe('focus hand-offs while an overlay unregisters', () => {
    /**
     * An overlay owner in the same tree as the body (the shell's own + sheet),
     * plus an editor and an opener inside the body. jsdom evaluates no `inert`,
     * so a `focus()` spy records whether the body was still inert at the moment
     * of each call, which is what a real browser would act on.
     */
    function Harness(): React.JSX.Element {
      const bodyRef = useRef<HTMLDivElement>(null)
      const editorRef = useRef<HTMLInputElement>(null)
      const openerRef = useRef<HTMLButtonElement>(null)
      const [open, setOpen] = useState(false)
      useInertBehindOverlays(bodyRef)
      useOverlayRegistration('composer-add-sheet', open, () => setOpen(false))

      return (
        <div>
          <div ref={bodyRef} data-testid="body">
            <button type="button" ref={openerRef} onClick={() => setOpen(true)}>
              opener
            </button>
            <input aria-label="editor" ref={editorRef} />
          </div>
          {open && (
            <div role="dialog">
              <button
                type="button"
                onClick={() => {
                  // ComposerAddSheet's Mention and Commands: a flushSync close,
                  // then the editor takes focus.
                  flushSync(() => setOpen(false))
                  editorRef.current?.focus()
                }}
              >
                mention
              </button>
              <button
                type="button"
                onClick={() => {
                  // Radix's onCloseAutoFocus: a timer after the close, focus
                  // returns to the opener inside the body.
                  setOpen(false)
                  setTimeout(() => openerRef.current?.focus(), 0)
                }}
              >
                dismiss
              </button>
            </div>
          )}
        </div>
      )
    }

    /** `[focus target, whether the body was inert at that moment]`, per call. */
    let focusCalls: Array<[string, boolean]>

    beforeEach(() => {
      focusCalls = []
      const original = HTMLElement.prototype.focus
      vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
        this: HTMLElement,
        options?: FocusOptions
      ) {
        const label = this.getAttribute('aria-label') ?? this.textContent ?? ''
        focusCalls.push([
          label,
          document.querySelector('[data-testid="body"]')?.hasAttribute('inert') ?? false
        ])
        original.call(this, options)
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('has lifted inert when a flushSync close is followed by focusing an input in the body', () => {
      render(<Harness />)

      fireEvent.click(screen.getByText('opener'))
      expect(bodyEl()).toHaveAttribute('inert')

      fireEvent.click(screen.getByText('mention'))

      expect(focusCalls).toEqual([['editor', false]])
      expect(bodyEl()).not.toHaveAttribute('inert')
      expect(screen.getByLabelText('editor')).toHaveFocus()
    })

    it('has lifted inert when an opener inside the body takes focus back after the last close', async () => {
      render(<Harness />)

      fireEvent.click(screen.getByText('opener'))
      expect(bodyEl()).toHaveAttribute('inert')

      fireEvent.click(screen.getByText('dismiss'))

      await waitFor(() => expect(screen.getByText('opener')).toHaveFocus())
      expect(focusCalls).toEqual([['opener', false]])
      expect(bodyEl()).not.toHaveAttribute('inert')
    })
  })
})
