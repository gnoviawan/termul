import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { createHashRouter, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { useThemePickerStore } from '@/stores/theme-picker-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useWorkspaceOverlayBackStack } from './use-workspace-overlay-back-stack'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

type Args = Parameters<typeof useWorkspaceOverlayBackStack>[0]

function makeArgs(overrides: Partial<Args> = {}): Args {
  return {
    isMobileWebShell: true,
    gitSheetOpen: false,
    setGitSheetOpen: vi.fn(),
    isCommandPaletteOpen: false,
    setIsCommandPaletteOpen: vi.fn(),
    isCommandHistoryOpen: false,
    setIsCommandHistoryOpen: vi.fn(),
    isSshPasswordPromptOpen: false,
    closeSshPasswordPrompt: vi.fn(),
    locationKey: 'k1',
    ...overrides
  }
}

const initialWorkspace = useWorkspaceStore.getState()
const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

function mountHook(overrides: Partial<Args> = {}) {
  const args = makeArgs(overrides)
  const view = renderHook((props: Args) => useWorkspaceOverlayBackStack(props), {
    initialProps: args
  })
  return { args, ...view }
}

/** Seed the active pane with one tab, then point the launcher at it. */
function showLauncherOnPaneWithTabs(): void {
  useWorkspaceStore.getState().addBrowserTab('b1')
  const paneId = useWorkspaceStore.getState().activePaneId
  if (paneId) useWorkspaceStore.getState().showAgentLauncher(paneId)
}

describe('useWorkspaceOverlayBackStack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOverlayStackStore.setState({ stack: [], mobileShell: false })
    useSettingsModalStore.setState({ view: null })
    useThemePickerStore.setState({
      isOpen: false,
      initialEffectiveThemeId: null,
      highlightedThemeId: null
    })
    useWorkspaceStore.setState({
      root: initialWorkspace.root,
      activePaneId: initialWorkspace.activePaneId,
      agentLauncherPaneId: null
    })
    // A route entry below the base entry, so a route back has somewhere to go.
    window.history.replaceState(null, '', '#/route-a')
    window.history.pushState(null, '', '#/base')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('mobile-shell flag', () => {
    it('follows isMobileWebShell and resets to false on unmount', () => {
      const { rerender, unmount } = mountHook({ isMobileWebShell: true })
      expect(useOverlayStackStore.getState().mobileShell).toBe(true)

      rerender(makeArgs({ isMobileWebShell: false }))
      expect(useOverlayStackStore.getState().mobileShell).toBe(false)

      rerender(makeArgs({ isMobileWebShell: true }))
      expect(useOverlayStackStore.getState().mobileShell).toBe(true)

      unmount()
      expect(useOverlayStackStore.getState().mobileShell).toBe(false)
    })
  })

  describe.each([
    ['mobile', true],
    ['desktop', false]
  ])('default-scope registrations (%s)', (_label, isMobileWebShell) => {
    it('registers the git sheet and closes it through its owner', () => {
      const { args, rerender } = mountHook({ isMobileWebShell })
      rerender({ ...args, gitSheetOpen: true })

      expect(stackIds()).toEqual(['git-sheet'])
      useOverlayStackStore.getState().closeTopmostOverlay()
      expect(args.setGitSheetOpen).toHaveBeenCalledWith(false)
    })

    it('registers the command palette and closes it through its owner', () => {
      const { args, rerender } = mountHook({ isMobileWebShell })
      rerender({ ...args, isCommandPaletteOpen: true })

      expect(stackIds()).toEqual(['command-palette'])
      useOverlayStackStore.getState().closeTopmostOverlay()
      expect(args.setIsCommandPaletteOpen).toHaveBeenCalledWith(false)
    })

    it('registers App Preferences and closes it through the settings store', () => {
      mountHook({ isMobileWebShell })
      act(() => useSettingsModalStore.getState().openApp())

      expect(stackIds()).toEqual(['settings-modal'])
      act(() => {
        useOverlayStackStore.getState().closeTopmostOverlay()
      })
      expect(useSettingsModalStore.getState().view).toBeNull()
    })
  })

  describe('mobile-shell-only registrations', () => {
    it('agent-launcher registers only for a pane that has tabs, and closes through hideAgentLauncher', () => {
      mountHook()
      act(() => showLauncherOnPaneWithTabs())

      expect(stackIds()).toEqual(['agent-launcher'])
      act(() => {
        useOverlayStackStore.getState().closeTopmostOverlay()
      })
      expect(useWorkspaceStore.getState().agentLauncherPaneId).toBeNull()
      expect(stackIds()).toEqual([])
    })

    it('an empty pane renders the launcher as its body: no entry and no sentinel', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      mountHook()

      act(() => {
        const paneId = useWorkspaceStore.getState().activePaneId
        if (paneId) useWorkspaceStore.getState().showAgentLauncher(paneId)
      })
      await settleOverlayBackStack()

      expect(useWorkspaceStore.getState().agentLauncherPaneId).not.toBeNull()
      expect(stackIds()).toEqual([])
      expect(pushSpy).not.toHaveBeenCalled()
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a launcher pointing at a pane that no longer exists is not an overlay', () => {
      mountHook()
      act(() => useWorkspaceStore.getState().showAgentLauncher('missing-pane'))

      expect(stackIds()).toEqual([])
    })

    it('command-history closes through its owner', () => {
      const { args, rerender } = mountHook()
      rerender({ ...args, isCommandHistoryOpen: true })

      expect(stackIds()).toEqual(['command-history'])
      useOverlayStackStore.getState().closeTopmostOverlay()
      expect(args.setIsCommandHistoryOpen).toHaveBeenCalledWith(false)
    })

    it('theme-picker closes through cancel(), reverting the preview like Esc', () => {
      mountHook()
      act(() => useThemePickerStore.getState().open('termul'))

      expect(stackIds()).toEqual(['theme-picker'])
      const cancelSpy = vi.spyOn(useThemePickerStore.getState(), 'cancel')
      act(() => {
        useOverlayStackStore.getState().closeTopmostOverlay()
      })
      expect(cancelSpy).toHaveBeenCalledTimes(1)
      expect(useThemePickerStore.getState().isOpen).toBe(false)
    })

    it('ssh-password-prompt closes by clearing the prompt, as Cancel does', () => {
      const { args, rerender } = mountHook()
      rerender({ ...args, isSshPasswordPromptOpen: true })

      expect(stackIds()).toEqual(['ssh-password-prompt'])
      useOverlayStackStore.getState().closeTopmostOverlay()
      expect(args.closeSshPasswordPrompt).toHaveBeenCalledTimes(1)
    })

    it('are inert on desktop: nothing registers and nothing is pushed', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      const { args, rerender } = mountHook({ isMobileWebShell: false })

      rerender({
        ...args,
        isCommandHistoryOpen: true,
        isSshPasswordPromptOpen: true
      })
      act(() => {
        showLauncherOnPaneWithTabs()
        useThemePickerStore.getState().open('termul')
      })
      await settleOverlayBackStack()

      expect(stackIds()).toEqual([])
      expect(pushSpy).not.toHaveBeenCalled()
    })
  })

  describe('sentinel ownership', () => {
    it('desktop keeps the legacy push-on-growth with the legacy sentinel shape', () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      const { args, rerender } = mountHook({ isMobileWebShell: false })

      rerender({ ...args, gitSheetOpen: true })

      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(pushSpy).toHaveBeenCalledWith({ termulOverlay: true }, '')
    })

    it('desktop re-renders the host when the stack grows (the legacy push needs the count)', () => {
      let renders = 0
      const args = makeArgs({ isMobileWebShell: false })
      renderHook(() => {
        renders += 1
        useWorkspaceOverlayBackStack(args)
      })
      const before = renders

      act(() => useOverlayStackStore.getState().registerOverlay('probe', vi.fn()))

      expect(renders).toBeGreaterThan(before)
    })

    it('mobile does not re-render the host on a stack change (a nested Radix layer must not be re-rendered mid-tap)', async () => {
      let renders = 0
      const args = makeArgs()
      renderHook(() => {
        renders += 1
        useWorkspaceOverlayBackStack(args)
      })
      const before = renders

      act(() => useOverlayStackStore.getState().registerOverlay('probe', vi.fn()))
      act(() => useOverlayStackStore.getState().unregisterOverlay('probe'))
      await settleOverlayBackStack()

      expect(renders).toBe(before)
    })

    it('flipping mobile to desktop with an overlay open arms no extra legacy sentinel, and later growth still pushes', async () => {
      const { args, rerender } = mountHook({ isMobileWebShell: true })
      rerender({ ...args, gitSheetOpen: true })
      await waitForSentinelDepth(1)
      const pushSpy = vi.spyOn(history, 'pushState')

      rerender({ ...args, gitSheetOpen: true, isMobileWebShell: false })
      expect(pushSpy).not.toHaveBeenCalled()

      rerender({ ...args, gitSheetOpen: true, isCommandPaletteOpen: true, isMobileWebShell: false })
      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(pushSpy).toHaveBeenCalledWith({ termulOverlay: true }, '')
    })

    it('mobile arms exactly one managed sentinel per overlay (no double arm)', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      const { args, rerender } = mountHook()

      rerender({ ...args, gitSheetOpen: true })
      await waitForSentinelDepth(1)
      await settleOverlayBackStack()

      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(history.state).toEqual({ termulOverlay: true, termulOverlayDepth: 1 })
      expect(location.hash).toBe('#/base')
    })

    it('system back closes the topmost overlay through its owner and consumes the sentinel', async () => {
      const { args, rerender } = mountHook()
      rerender({ ...args, gitSheetOpen: true })
      await waitForSentinelDepth(1)

      await pressSystemBack()

      expect(args.setGitSheetOpen).toHaveBeenCalledTimes(1)
      expect(args.setGitSheetOpen).toHaveBeenCalledWith(false)
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
    })

    it('palette to sub-modal in one flush neither traverses nor pushes', async () => {
      const { args, rerender } = mountHook()
      rerender({ ...args, isCommandPaletteOpen: true })
      await waitForSentinelDepth(1)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const pushSpy = vi.spyOn(history, 'pushState')

      rerender({ ...args, isCommandPaletteOpen: false, isCommandHistoryOpen: true })
      await settleOverlayBackStack()

      expect(stackIds()).toEqual(['command-history'])
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(pushSpy).not.toHaveBeenCalled()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
    })

    it('system back closes the ssh password prompt and the theme picker through their owners', async () => {
      const { args, rerender } = mountHook()

      rerender({ ...args, isSshPasswordPromptOpen: true })
      await waitForSentinelDepth(1)
      await pressSystemBack()
      expect(args.closeSshPasswordPrompt).toHaveBeenCalledTimes(1)
      expect(readOverlaySentinelDepth(history.state)).toBe(0)

      rerender({ ...args, isSshPasswordPromptOpen: false })
      act(() => useThemePickerStore.getState().open('termul'))
      await waitForSentinelDepth(1)
      await pressSystemBack()
      expect(useThemePickerStore.getState().isOpen).toBe(false)
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(location.hash).toBe('#/base')
    })

    it('installs the back handler once (one overlay closes per back press)', async () => {
      const { args, rerender } = mountHook()
      rerender({ ...args, gitSheetOpen: true, isCommandPaletteOpen: true })
      await waitForSentinelDepth(2)

      await pressSystemBack()

      expect(args.setIsCommandPaletteOpen).toHaveBeenCalledTimes(1)
      expect(args.setGitSheetOpen).not.toHaveBeenCalled()
    })

    it('unmount detaches the handler: a back press closes nothing', async () => {
      const { args, rerender, unmount } = mountHook()
      rerender({ ...args, gitSheetOpen: true })
      await waitForSentinelDepth(1)
      unmount()

      await pressSystemBack()

      expect(args.setGitSheetOpen).not.toHaveBeenCalled()
    })
  })

  describe('route change with an overlay open (L-33)', () => {
    it('a location key change re-arms the sentinel on the new entry, so one back closes the overlay and keeps the route', async () => {
      const { args, rerender } = mountHook()
      rerender({ ...args, gitSheetOpen: true })
      await waitForSentinelDepth(1)

      // The router pushes a route (no popstate) and the layout's location key changes.
      history.pushState({ usr: null, key: 'k2', idx: 2 }, '', '#/c/chat-1')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      rerender({ ...args, gitSheetOpen: true, locationKey: 'k2' })
      await waitForSentinelDepth(1)
      expect(location.hash).toBe('#/c/chat-1')

      await pressSystemBack()
      expect(args.setGitSheetOpen).toHaveBeenCalledTimes(1)
      expect(args.setGitSheetOpen).toHaveBeenCalledWith(false)
      expect(location.hash).toBe('#/c/chat-1')
    })

    it('a route replace that dropped the marker is re-armed too', async () => {
      const { args, rerender } = mountHook()
      rerender({ ...args, gitSheetOpen: true })
      await waitForSentinelDepth(1)

      history.replaceState({ usr: null, key: 'k2', idx: 1 }, '', '#/replaced')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      rerender({ ...args, gitSheetOpen: true, locationKey: 'k2' })
      await waitForSentinelDepth(1)

      await pressSystemBack()
      expect(args.setGitSheetOpen).toHaveBeenCalledTimes(1)
      expect(location.hash).toBe('#/replaced')
    })

    describe('through a real createHashRouter (the layout wiring itself is covered in WorkspaceLayout.mobile.test.tsx)', () => {
      const closeGitSheet = vi.fn()

      /** What WorkspaceLayout does: feed `useLocation().key` to the hook. */
      function LayoutProbe(): null {
        const location = useLocation()
        const [gitSheetOpen, setGitSheetOpen] = useState(true)
        useWorkspaceOverlayBackStack(
          makeArgs({
            gitSheetOpen,
            setGitSheetOpen: (open: boolean) => {
              closeGitSheet(open)
              setGitSheetOpen(open)
            },
            locationKey: location.key
          })
        )
        return null
      }

      function mountRouter() {
        const router = createHashRouter([{ path: '*', element: <LayoutProbe /> }])
        const view = render(
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        )
        return { router, ...view }
      }

      it('a router push re-arms the sentinel on the new entry, so one back closes the overlay and keeps the route', async () => {
        const { router, unmount } = mountRouter()
        await waitForSentinelDepth(1)

        await act(async () => {
          await router.navigate('/c/chat-1')
        })
        await waitForSentinelDepth(1)
        expect(location.hash).toBe('#/c/chat-1')

        await pressSystemBack()
        expect(closeGitSheet).toHaveBeenCalledTimes(1)
        expect(location.hash).toBe('#/c/chat-1')
        await waitForSentinelDepth(0)

        // The sentinel the push left below the route copies the previous entry:
        // the stale-sentinel skip passes over it, so the next back is a route back.
        await pressSystemBack()
        await waitFor(() => expect(location.hash).toBe('#/base'))
        await waitForSentinelDepth(0)
        expect(closeGitSheet).toHaveBeenCalledTimes(1)

        unmount()
        router.dispose()
      })

      it('a router replace re-arms the sentinel, so one back closes the overlay and keeps the route', async () => {
        const { router, unmount } = mountRouter()
        await waitForSentinelDepth(1)

        await act(async () => {
          await router.navigate('/replaced', { replace: true })
        })
        await waitForSentinelDepth(1)
        expect(location.hash).toBe('#/replaced')

        await pressSystemBack()
        expect(closeGitSheet).toHaveBeenCalledTimes(1)
        expect(location.hash).toBe('#/replaced')

        unmount()
        router.dispose()
      })
    })

    it('does nothing on mount or while the key stays the same', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      const { args, rerender } = mountHook()
      await settleOverlayBackStack()
      expect(pushSpy).not.toHaveBeenCalled()

      rerender({ ...args, gitSheetOpen: true })
      await waitForSentinelDepth(1)
      rerender({ ...args, gitSheetOpen: true, locationKey: 'k1' })
      await settleOverlayBackStack()

      expect(pushSpy).toHaveBeenCalledTimes(1)
    })

    it('desktop makes no history call for a key change', async () => {
      const { args, rerender } = mountHook({ isMobileWebShell: false })
      rerender({ ...args, gitSheetOpen: true })
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      rerender({ ...args, gitSheetOpen: true, locationKey: 'k2' })
      await settleOverlayBackStack()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })

  describe('mobile to desktop flip with overlays open (L-34)', () => {
    /** Owners with real state, so a flip and a close behave like the layout's. */
    function useFlipOwners() {
      const [isMobileWebShell, setIsMobileWebShell] = useState(true)
      const [gitSheetOpen, setGitSheetOpen] = useState(false)
      const [isCommandHistoryOpen, setIsCommandHistoryOpen] = useState(false)
      const [isSshPasswordPromptOpen, setIsSshPasswordPromptOpen] = useState(false)
      useWorkspaceOverlayBackStack(
        makeArgs({
          isMobileWebShell,
          gitSheetOpen,
          setGitSheetOpen,
          isCommandHistoryOpen,
          setIsCommandHistoryOpen,
          isSshPasswordPromptOpen,
          closeSshPasswordPrompt: () => setIsSshPasswordPromptOpen(false)
        })
      )
      return {
        gitSheetOpen,
        setIsMobileWebShell,
        setGitSheetOpen,
        setIsCommandHistoryOpen,
        setIsSshPasswordPromptOpen
      }
    }

    it('consumes every stranded sentinel when only mobile-only overlays were open, so the next back is a route back', async () => {
      const { result } = renderHook(() => useFlipOwners())
      act(() => result.current.setIsCommandHistoryOpen(true))
      act(() => result.current.setIsSshPasswordPromptOpen(true))
      await waitForSentinelDepth(2)
      const goSpy = vi.spyOn(history, 'go')

      act(() => result.current.setIsMobileWebShell(false))
      await waitForSentinelDepth(0)

      expect(stackIds()).toEqual([])
      expect(goSpy).toHaveBeenCalledTimes(1)
      expect(goSpy).toHaveBeenCalledWith(-2)
      expect(location.hash).toBe('#/base')

      await pressSystemBack()
      expect(location.hash).toBe('#/route-a')
    })

    it('keeps one sentinel for the default-scope overlay: the next back closes it once', async () => {
      const { result } = renderHook(() => useFlipOwners())
      act(() => result.current.setGitSheetOpen(true))
      act(() => result.current.setIsCommandHistoryOpen(true))
      await waitForSentinelDepth(2)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      act(() => result.current.setIsMobileWebShell(false))
      await waitForSentinelDepth(1)

      // One cleanup traversal of one entry (history.back()), nothing closed by it.
      expect(backSpy).toHaveBeenCalledTimes(1)
      expect(goSpy).not.toHaveBeenCalled()
      expect(stackIds()).toEqual(['git-sheet'])
      expect(result.current.gitSheetOpen).toBe(true)

      // The legacy popstate path closes the git sheet through its owner, once.
      // (The route back after it is asserted in the store-level flip test: the
      // legacy re-arm hazard with an owner that unregisters one render later is
      // out of scope here.)
      await pressSystemBack()
      expect(result.current.gitSheetOpen).toBe(false)
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
    })

    it('makes no history call when no sentinel is stranded', async () => {
      const { result } = renderHook(() => useFlipOwners())
      act(() => result.current.setGitSheetOpen(true))
      await waitForSentinelDepth(1)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')

      act(() => result.current.setIsMobileWebShell(false))
      await settleOverlayBackStack()

      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
    })
  })

  // Desktop / desktop-web (`isMobileWebShell` false) keeps the legacy
  // push-on-growth + popstate path: the hook must still install the handler
  // there, or browser Back leaves overlays open while their sentinel is armed.
  describe('desktop back handling (legacy path)', () => {
    /** Owners with real state, so a close actually flips the overlay's `open`. */
    function useDesktopOwners() {
      const [gitSheetOpen, setGitSheetOpen] = useState(false)
      const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
      useWorkspaceOverlayBackStack(
        makeArgs({
          isMobileWebShell: false,
          gitSheetOpen,
          setGitSheetOpen,
          isCommandPaletteOpen,
          setIsCommandPaletteOpen
        })
      )
      return { gitSheetOpen, setGitSheetOpen, isCommandPaletteOpen, setIsCommandPaletteOpen }
    }

    it('browser back closes one overlay per press through the installed handler', async () => {
      const { result } = renderHook(() => useDesktopOwners())
      expect(useOverlayStackStore.getState().mobileShell).toBe(false)

      act(() => result.current.setGitSheetOpen(true))
      act(() => result.current.setIsCommandPaletteOpen(true))
      expect(stackIds()).toEqual(['git-sheet', 'command-palette'])
      // Legacy sentinel shape: no depth tag, owned by push-on-growth.
      expect(history.state).toEqual({ termulOverlay: true })

      await pressSystemBack()
      expect(result.current.isCommandPaletteOpen).toBe(false)
      expect(result.current.gitSheetOpen).toBe(true)
      expect(stackIds()).toEqual(['git-sheet'])

      // The legacy re-arm left a sentinel for the next press.
      await pressSystemBack()
      expect(result.current.gitSheetOpen).toBe(false)
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
    })

    it('has no Esc fallback: an Esc nobody handles closes nothing', async () => {
      const { result } = renderHook(() => useDesktopOwners())
      act(() => result.current.setGitSheetOpen(true))

      fireEvent.keyDown(document.body, { key: 'Escape' })
      await settleOverlayBackStack()

      expect(result.current.gitSheetOpen).toBe(true)
      expect(stackIds()).toEqual(['git-sheet'])
    })
  })
})
