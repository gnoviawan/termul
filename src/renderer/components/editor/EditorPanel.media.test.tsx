import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readMediaBytesMock } = vi.hoisted(() => ({ readMediaBytesMock: vi.fn() }))

vi.mock('@/lib/api', () => ({
  filesystemApi: { readFile: vi.fn(), writeFile: vi.fn(), getFileInfo: vi.fn() },
  clipboardApi: { writeText: vi.fn() },
  openerApi: { revealInFileManager: vi.fn() }
}))
vi.mock('@/lib/media-bytes-api', () => ({
  readMediaBytes: (path: string) => readMediaBytesMock(path)
}))
vi.mock('@/hooks/use-toc-settings', () => ({ useTocSettings: vi.fn() }))
vi.mock('./CodeEditor', () => ({
  CodeEditor: (props: { content: string }) => <pre data-testid="code-editor">{props.content}</pre>
}))

import { type EditorFileState, useEditorStore } from '@/stores/editor-store'
import { EditorPanel } from './EditorPanel'

const urlApi = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown }
const blobs: Blob[] = []

function seed(file: EditorFileState): void {
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

beforeEach(() => {
  blobs.length = 0
  urlApi.createObjectURL = (blob: Blob) => {
    blobs.push(blob)
    return `blob:termul/${blobs.length}`
  }
  urlApi.revokeObjectURL = () => {}
  readMediaBytesMock.mockReset()
  readMediaBytesMock.mockResolvedValue({ success: true, data: new Blob(['bytes']) })
})

afterEach(() => {
  cleanup()
  useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
  delete urlApi.createObjectURL
  delete urlApi.revokeObjectURL
})

describe('EditorPanel viewer per file kind', () => {
  it('renders an image tab as an image read through readMediaBytes', async () => {
    seed({ ...base, kind: 'image', filePath: '/p/shot.png', revision: 0 })
    render(<EditorPanel filePath="/p/shot.png" isVisible />)

    expect(await screen.findByRole('img', { name: 'shot.png' })).toHaveAttribute(
      'src',
      'blob:termul/1'
    )
    expect(readMediaBytesMock).toHaveBeenCalledWith('/p/shot.png')
    expect(screen.queryByTestId('code-editor')).toBeNull()
  })

  it('renders a video tab as a video player with controls', async () => {
    seed({ ...base, kind: 'video', filePath: '/p/clip.mp4', revision: 0 })
    const { container } = render(<EditorPanel filePath="/p/clip.mp4" isVisible />)

    await screen.findByLabelText('clip.mp4')
    const video = container.querySelector('video')
    expect(video).toHaveAttribute('src', 'blob:termul/1')
    expect(video).toHaveAttribute('controls')
  })

  it('renders an unsupported tab with its name, reason, and size', () => {
    seed({ ...base, kind: 'unsupported', filePath: '/p/app.exe', reason: 'binary', size: 2048 })
    render(<EditorPanel filePath="/p/app.exe" isVisible />)

    expect(screen.getByText('app.exe')).toBeInTheDocument()
    expect(screen.getByText("This file can't be previewed")).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Path' })).toBeInTheDocument()
    expect(readMediaBytesMock).not.toHaveBeenCalled()
  })

  it('renders a text tab in the code editor', () => {
    seed({
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
    seed({
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
