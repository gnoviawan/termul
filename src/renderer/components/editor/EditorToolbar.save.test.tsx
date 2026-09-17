import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorToolbar } from './EditorToolbar'

// Story 4 (QA r2 P1): mobile web shell had NO save affordance — phones have
// no Ctrl key, so edits were unrecoverable. Matrix row 2: tap Save →
// immediate save call through the same save path as Ctrl+S
// (requestSaveEditorFile → editor-store.saveFile), button disabled while
// not dirty or saving, dirty clears on success.

const { mobileRef, mocks } = vi.hoisted(() => ({
  mobileRef: { current: false as boolean },
  mocks: {
    requestSaveEditorFile: vi.fn(),
    openFiles: new Map<
      string,
      { isDirty: boolean; operationStatus: 'idle' | 'saving' | 'reloading' | 'saved' }
    >(),
    subscribe: vi.fn(),
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
  }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

vi.mock('@/lib/editor-save', () => ({
  requestSaveEditorFile: mocks.requestSaveEditorFile
}))

vi.mock('@/stores/toc-settings-store', () => ({
  useTocIsVisible: () => true,
  useTocSettingsStore: (selector: (state: { toggleVisibility: () => void }) => unknown) =>
    selector({ toggleVisibility: vi.fn() })
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: Object.assign(
    (
      selector: (state: {
        openFiles: Map<string, { isDirty: boolean; operationStatus: string }>
      }) => unknown
    ) => selector({ openFiles: mocks.openFiles }),
    {
      getState: () => ({ openFiles: mocks.openFiles })
    }
  )
}))

vi.mock('sonner', () => ({
  toast: mocks.toast
}))

const FILE_PATH = '/repo/docs/README.md'

function seedFile(isDirty: boolean, operationStatus = 'idle' as const): void {
  mocks.openFiles.set(FILE_PATH, { isDirty, operationStatus })
}

const renderToolbar = (): HTMLElement => {
  const { container } = render(
    <EditorToolbar viewMode="markdown" onToggleViewMode={vi.fn()} filePath={FILE_PATH} />
  )
  return container
}

const findSaveButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Save README.md' }) as HTMLButtonElement

describe('EditorToolbar mobile Save affordance (QA r2 story 4, matrix row 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = true
    mocks.openFiles = new Map()
    mocks.requestSaveEditorFile.mockResolvedValue(true)
  })

  afterEach(() => {
    mobileRef.current = false
  })

  it('renders a Save button on the mobile shell, absent on desktop', () => {
    seedFile(true)
    renderToolbar()
    expect(findSaveButton()).toBeInTheDocument()

    cleanup()
    mobileRef.current = false
    seedFile(true)
    renderToolbar()
    expect(screen.queryByRole('button', { name: 'Save README.md' })).not.toBeInTheDocument()
  })

  it('meets the 44px touch floor (touch size + hit-slop + min-h-11)', () => {
    seedFile(true)
    renderToolbar()

    const button = findSaveButton()
    expect(button.className).toContain('h-11')
    expect(button.className).toContain('after:-inset-1.5')
    expect(button.className).toContain('min-h-11')
  })

  it('is disabled when the file is not dirty', () => {
    seedFile(false)
    renderToolbar()

    expect(findSaveButton()).toBeDisabled()
  })

  it('is disabled while a save is in flight', () => {
    seedFile(true, 'saving')
    renderToolbar()

    expect(findSaveButton()).toBeDisabled()
  })

  it('tapping Save with a dirty file triggers the save path immediately', async () => {
    seedFile(true)
    renderToolbar()

    fireEvent.click(findSaveButton())

    expect(mocks.requestSaveEditorFile).toHaveBeenCalledTimes(1)
    expect(mocks.requestSaveEditorFile).toHaveBeenCalledWith(FILE_PATH)
  })

  it('tapping Save on a clean buffer makes no save call', () => {
    seedFile(false)
    renderToolbar()

    // Even if the button were somehow tapped, the handler re-checks dirty.
    const button = findSaveButton()
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(mocks.requestSaveEditorFile).not.toHaveBeenCalled()
  })

  it('a failed save keeps the file dirty and the button re-enables for retry', async () => {
    seedFile(true)
    mocks.requestSaveEditorFile.mockResolvedValue(false)
    renderToolbar()

    fireEvent.click(findSaveButton())

    await waitFor(() => {
      // Still dirty, still tappable — the error surfaced via the existing
      // toast channel inside requestSaveEditorFile.
      expect(findSaveButton()).toBeEnabled()
    })
    expect(mocks.requestSaveEditorFile).toHaveBeenCalledTimes(1)
  })

  it('successful save clears dirty state through the store (button disables again)', async () => {
    seedFile(true)
    mocks.requestSaveEditorFile.mockImplementation(async () => {
      // The store path clears the dirty flag on success.
      seedFile(false)
      return true
    })
    renderToolbar()

    fireEvent.click(findSaveButton())

    await waitFor(() => {
      expect(findSaveButton()).toBeDisabled()
    })
    expect(mocks.requestSaveEditorFile).toHaveBeenCalledTimes(1)
  })
})

function cleanup(): void {
  // Testing Library cleanup between the two renders inside the first test.
  document.body.innerHTML = ''
}
