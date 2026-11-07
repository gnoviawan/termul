import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { codeEditorProps, markdownEditorProps, readMediaBytesMock, openPdfDocumentMock } =
  vi.hoisted(() => ({
    codeEditorProps: vi.fn(),
    markdownEditorProps: vi.fn(),
    readMediaBytesMock: vi.fn(),
    openPdfDocumentMock: vi.fn()
  }))

vi.mock('@/lib/api', () => ({
  filesystemApi: { readFile: vi.fn(), writeFile: vi.fn(), getFileInfo: vi.fn() },
  clipboardApi: { writeText: vi.fn() },
  openerApi: { revealInFileManager: vi.fn() }
}))
vi.mock('@/lib/media-bytes-api', () => ({
  readMediaBytes: (path: string) => readMediaBytesMock(path)
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('./media/pdf-document', () => ({ openPdfDocument: openPdfDocumentMock }))
vi.mock('@/hooks/use-toc-settings', () => ({ useTocSettings: vi.fn() }))
vi.mock('./CodeEditor', () => ({
  CodeEditor: (props: { readOnly?: boolean; content: string }) => {
    codeEditorProps(props)
    return <pre data-testid="code-editor">{props.content}</pre>
  }
}))
vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: (props: { readOnly?: boolean }) => {
    markdownEditorProps(props)
    return <div data-testid="markdown-editor" />
  }
}))

import { type EditorFileState, useEditorStore } from '@/stores/editor-store'
import { EditorPanel } from './EditorPanel'

const FILE = '/project/notes.md'

function seed(overrides: Partial<EditorFileState> = {}): void {
  useEditorStore.setState({
    openFiles: new Map([
      [
        FILE,
        {
          filePath: FILE,
          content: 'disk version',
          kind: 'text',
          originalContent: 'disk version',
          isDirty: false,
          language: 'markdown',
          lastModified: 9_000,
          viewMode: 'code',
          cursorPosition: { line: 1, col: 1 },
          scrollTop: 0,
          operationStatus: 'idle',
          ...overrides
        }
      ]
    ]),
    activeFilePath: FILE
  })
}

beforeEach(() => {
  codeEditorProps.mockClear()
  markdownEditorProps.mockClear()
})

afterEach(() => {
  cleanup()
  useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
})

describe('EditorPanel draft conflict lock', () => {
  it('keeps the code editor writable when there is no conflict', () => {
    seed()
    render(<EditorPanel filePath={FILE} isVisible />)
    expect(codeEditorProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false }))
  })

  it('makes the code editor read-only while a draft conflict is unresolved', () => {
    seed({ draftConflict: { draftContent: 'draft', draftSavedAt: 1_000 } })
    render(<EditorPanel filePath={FILE} isVisible />)
    expect(codeEditorProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }))
  })

  it('makes the markdown editor read-only while a draft conflict is unresolved', () => {
    seed({
      viewMode: 'preview',
      draftConflict: { draftContent: 'draft', draftSavedAt: 1_000 }
    })
    render(<EditorPanel filePath={FILE} isVisible />)
    expect(markdownEditorProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: true })
    )
  })

  it('unlocks the editor once the conflict is resolved', () => {
    seed({ draftConflict: { draftContent: 'draft', draftSavedAt: 1_000 } })
    const { rerender } = render(<EditorPanel filePath={FILE} isVisible />)

    useEditorStore.getState().resolveDraftConflict(FILE, 'disk')
    rerender(<EditorPanel filePath={FILE} isVisible />)

    expect(codeEditorProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false }))
  })
})

const urlApi = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }
const blobs: Blob[] = []

function seedFile(file: EditorFileState): void {
  useEditorStore.setState({
    openFiles: new Map([[file.filePath, file]]),
    activeFilePath: file.filePath
  })
}

/** jsdom's Blob has no `text()`. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

const base = { isDirty: false, lastModified: 1, operationStatus: 'idle' } as const

function stubObjectUrls(): void {
  blobs.length = 0
  urlApi.createObjectURL = (blob: Blob) => {
    blobs.push(blob)
    return `blob:termul/${blobs.length}`
  }
  urlApi.revokeObjectURL = () => {}
  readMediaBytesMock.mockReset()
  readMediaBytesMock.mockResolvedValue({ success: true, data: new Blob(['bytes']) })
}

afterEach(() => {
  delete urlApi.createObjectURL
  delete urlApi.revokeObjectURL
})

describe('EditorPanel viewer per file kind', () => {
  beforeEach(stubObjectUrls)

  it('renders an image tab as an image read through readMediaBytes', async () => {
    seedFile({ ...base, kind: 'image', filePath: '/p/shot.png', revision: 0 })
    render(<EditorPanel filePath="/p/shot.png" isVisible />)

    expect(await screen.findByRole('img', { name: 'shot.png' })).toHaveAttribute(
      'src',
      'blob:termul/1'
    )
    expect(readMediaBytesMock).toHaveBeenCalledWith('/p/shot.png')
    expect(screen.queryByTestId('code-editor')).toBeNull()
  })

  it('does not read a hidden media tab until it is first shown, then reads it once', async () => {
    seedFile({ ...base, kind: 'image', filePath: '/p/shot.png', revision: 0 })
    const { rerender } = render(<EditorPanel filePath="/p/shot.png" isVisible={false} />)
    await Promise.resolve()
    expect(readMediaBytesMock).not.toHaveBeenCalled()

    rerender(<EditorPanel filePath="/p/shot.png" isVisible />)
    expect(await screen.findByRole('img', { name: 'shot.png' })).toHaveAttribute(
      'src',
      'blob:termul/1'
    )
    rerender(<EditorPanel filePath="/p/shot.png" isVisible={false} />)
    rerender(<EditorPanel filePath="/p/shot.png" isVisible />)
    expect(readMediaBytesMock).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'blob:termul/1')
  })

  it('renders a video tab as a video player with controls', async () => {
    seedFile({ ...base, kind: 'video', filePath: '/p/clip.mp4', revision: 0 })
    const { container } = render(<EditorPanel filePath="/p/clip.mp4" isVisible />)

    await screen.findByLabelText('clip.mp4')
    const video = container.querySelector('video')
    expect(video).toHaveAttribute('src', 'blob:termul/1')
    expect(video).toHaveAttribute('controls')
  })

  it('renders a pdf tab in the pdf viewer, which opens the bytes read through readMediaBytes', async () => {
    const bytes = new Blob(['%PDF-1.7'], { type: 'application/pdf' })
    readMediaBytesMock.mockResolvedValue({ success: true, data: bytes })
    openPdfDocumentMock.mockReturnValue({
      result: Promise.resolve({ ok: false, failure: 'password', errorName: 'PasswordException' }),
      destroy: vi.fn()
    })
    seedFile({ ...base, kind: 'pdf', filePath: '/p/report.pdf', revision: 0 })
    render(<EditorPanel filePath="/p/report.pdf" isVisible />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "report.pdf is password-protected and can't be previewed."
    )
    expect(readMediaBytesMock).toHaveBeenCalledWith('/p/report.pdf')
    expect(openPdfDocumentMock).toHaveBeenCalledWith(bytes)
  })

  it('renders an unsupported tab with its name, reason, and size', () => {
    seedFile({ ...base, kind: 'unsupported', filePath: '/p/app.exe', reason: 'binary', size: 2048 })
    render(<EditorPanel filePath="/p/app.exe" isVisible />)

    expect(screen.getByText('app.exe')).toBeInTheDocument()
    expect(screen.getByText("This file can't be previewed")).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Path' })).toBeInTheDocument()
    expect(readMediaBytesMock).not.toHaveBeenCalled()
  })

  it('renders a text tab in the code editor', () => {
    seedFile({
      ...base,
      kind: 'text',
      filePath: '/p/a.ts',
      content: 'const a = 1',
      originalContent: 'const a = 1',
      language: 'typescript',
      viewMode: 'code',
      cursorPosition: { line: 1, col: 1 },
      scrollTop: 0
    })
    render(<EditorPanel filePath="/p/a.ts" isVisible />)

    expect(screen.getByTestId('code-editor')).toHaveTextContent('const a = 1')
    expect(screen.queryByRole('radiogroup', { name: 'View mode' })).toBeNull()
  })
})

describe('EditorPanel SVG preview toggle', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'

  beforeEach(() => {
    stubObjectUrls()
    seedFile({
      ...base,
      kind: 'text',
      filePath: '/p/icon.svg',
      content: svg,
      originalContent: svg,
      language: 'xml',
      viewMode: 'preview',
      cursorPosition: { line: 1, col: 1 },
      scrollTop: 0
    })
  })

  it('renders the live buffer as an SVG blob image, then the source, then the image again', async () => {
    render(<EditorPanel filePath="/p/icon.svg" isVisible />)

    expect(await screen.findByRole('img', { name: 'icon.svg' })).toHaveAttribute(
      'src',
      'blob:termul/1'
    )
    expect(blobs[0].type).toBe('image/svg+xml')
    expect(await blobText(blobs[0])).toBe(svg)
    expect(screen.queryByTestId('code-editor')).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'Source' }))
    expect(screen.getByTestId('code-editor')).toHaveTextContent(svg)
    expect(screen.queryByRole('img', { name: 'icon.svg' })).toBeNull()
    expect(useEditorStore.getState().openFiles.get('/p/icon.svg')).toMatchObject({
      viewMode: 'code'
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Preview' }))
    expect(await screen.findByRole('img', { name: 'icon.svg' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Outline' })).toBeNull()
  })
})
