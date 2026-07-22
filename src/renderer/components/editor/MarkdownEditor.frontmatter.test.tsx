import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockNote } from '@/hooks/use-blocknote'
import { flushEditorContent } from '@/lib/editor-content-flush'
import { MarkdownEditor } from './MarkdownEditor'

vi.mock('@blocknote/react', () => ({
  BlockNoteViewRaw: () => null
}))

vi.mock('@/hooks/use-blocknote', () => ({
  useBlockNote: vi.fn()
}))

vi.mock('@/stores/toc-settings-store', () => ({
  useTocSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      isLoaded: true,
      loadFailed: false,
      settings: {
        isVisible: false,
        width: 280
      },
      setWidth: vi.fn()
    })
}))

type BlockNoteOptions = {
  filePath: string
  initialMarkdown: string
  onChange: (markdown: string) => void
}

const FM_CONTENT = `---
title: Spec
status: draft
---
# Heading

Body text.
`

describe('MarkdownEditor frontmatter strip/rejoin/flush', () => {
  let capturedOptions: BlockNoteOptions
  const replaceContent = vi.fn()
  const capturePendingContent = vi.fn(async () => '# Heading\n\nBody text.\n')
  const flushPendingContent = vi.fn(async () => {
    capturedOptions.onChange('# Heading\n\nBody text.\n')
  })

  beforeEach(() => {
    vi.clearAllMocks()
    capturePendingContent.mockResolvedValue('# Heading\n\nBody text.\n')
    flushPendingContent.mockImplementation(async () => {
      capturedOptions.onChange('# Heading\n\nBody text.\n')
    })

    vi.mocked(useBlockNote).mockImplementation((options: BlockNoteOptions) => {
      capturedOptions = options
      return {
        editor: {} as never,
        replaceContent,
        flushPendingContent,
        capturePendingContent,
        getHeadings: () => [],
        scrollToBlock: vi.fn()
      }
    })
  })

  it('passes body-only into useBlockNote and rejoins FM on body onChange', () => {
    const onChange = vi.fn()
    render(
      <MarkdownEditor filePath="/docs/spec.md" content={FM_CONTENT} isVisible onChange={onChange} />
    )

    expect(capturedOptions.initialMarkdown).toBe('# Heading\n\nBody text.\n')
    expect(capturedOptions.initialMarkdown.startsWith('---')).toBe(false)

    act(() => {
      capturedOptions.onChange('# Heading\n\nEdited body.\n')
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    const full = onChange.mock.calls[0]?.[0] as string
    expect(full.startsWith('---\n')).toBe(true)
    expect(full).toContain('title: Spec')
    expect(full).toContain('status: draft')
    expect(full).toContain('# Heading\n\nEdited body.\n')
  })

  it('flush path emits rejoined full file including frontmatter', async () => {
    const onChange = vi.fn()
    render(
      <MarkdownEditor filePath="/docs/spec.md" content={FM_CONTENT} isVisible onChange={onChange} />
    )

    await act(async () => {
      await flushEditorContent('/docs/spec.md')
    })

    expect(flushPendingContent).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
    const full = onChange.mock.calls.at(-1)?.[0] as string
    expect(full).toContain('title: Spec')
    expect(full).toContain('# Heading\n\nBody text.\n')
  })

  it('Properties edit captures body once and emits rejoined FM without replaceContent', async () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(
      <MarkdownEditor filePath="/docs/spec.md" content={FM_CONTENT} isVisible onChange={onChange} />
    )

    const titleInput = getByLabelText('title')
    await act(async () => {
      titleInput.focus()
      fireEvent.change(titleInput, { target: { value: 'Updated' } })
      fireEvent.blur(titleInput)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(capturePendingContent).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
    const full = onChange.mock.calls.at(-1)?.[0] as string
    expect(full).toContain('title: Updated')
    expect(full).toContain('# Heading\n\nBody text.\n')
    // FM-only edit must not treat store echo as external reload
    expect(replaceContent).not.toHaveBeenCalled()
  })
})
