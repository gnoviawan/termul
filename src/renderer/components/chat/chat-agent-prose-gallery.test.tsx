import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { AgentProse, TermulMarkdownGallery } from './chat-agent-prose'

const { readMediaBytesMock } = vi.hoisted(() => ({
  readMediaBytesMock: vi.fn((_path: string) => new Promise(() => {}))
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/media-bytes-api', () => ({
  readMediaBytes: (...args: unknown[]) => readMediaBytesMock(...args)
}))

const img = (name: string): string => `![${name}](https://img.test/${name}.png)`

// The streaming text commits at most every 100 ms; wait past that window.
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 250)))

function renderProse(text: string, streaming = false, filePathContext?: FilePathResolutionContext) {
  return render(
    <TooltipProvider>
      <AgentProse text={text} streaming={streaming} reduced filePathContext={filePathContext} />
    </TooltipProvider>
  )
}

function stripAlts(): string[][] {
  return screen
    .queryAllByTestId('chat-image-gallery')
    .map((strip) => [...strip.querySelectorAll('img')].map((image) => image.alt))
}

describe('AgentProse image galleries', () => {
  it('renders four images on one line as one strip of 112px tiles', async () => {
    renderProse(`Four avatars:\n\n${['a', 'b', 'c', 'd'].map(img).join(' ')}\n\nPick one.`)

    await waitFor(() => expect(stripAlts()).toEqual([['a', 'b', 'c', 'd']]))
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('width'))).toEqual([
      '112',
      '112',
      '112',
      '112'
    ])
  })

  it('renders image paragraphs separated by blank lines as one strip', async () => {
    renderProse(['a', 'b', 'c'].map(img).join('\n\n'))

    await waitFor(() => expect(stripAlts()).toEqual([['a', 'b', 'c']]))
  })

  it('keeps images split by text, or sharing a line with text, inline', async () => {
    renderProse(`${img('a')}\n\nBetween\n\n${img('b')}\n\nSee ${img('c')} and ${img('d')}`)

    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(4))
    expect(stripAlts()).toEqual([])
  })

  it('reads strip images relative to the chat cwd', async () => {
    renderProse('![a](out/a.png)\n\n![b](out/b.png)', false, { cwd: '/proj' })

    await waitFor(() =>
      expect(readMediaBytesMock.mock.calls.map(([path]) => path).sort()).toEqual([
        '/proj/out/a.png',
        '/proj/out/b.png'
      ])
    )
    expect(screen.getByRole('group', { name: '2 images' })).toBeInTheDocument()
  })

  it('renders a streamed run of image paragraphs as one strip', async () => {
    renderProse(`Shots:\n\n${['a', 'b', 'c'].map(img).join('\n\n')}\n\nMore`, true)
    await settle()

    expect(stripAlts()).toEqual([['a', 'b', 'c']])
  })

  it('opens a strip tile in the viewer at that image', async () => {
    renderProse(['a', 'b', 'c', 'd'].map(img).join('\n'))

    fireEvent.click(await screen.findByRole('button', { name: 'Open image: b' }))

    expect(screen.getByText('2 of 4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download b.png' })).toBeInTheDocument()
  })

  it('opens a single inline image in the viewer with download and no counter', async () => {
    renderProse(`Here:\n\n${img('solo')}`)

    fireEvent.click(await screen.findByRole('button', { name: 'Open image: solo' }))

    expect(screen.getByRole('button', { name: 'Download solo.png' })).toBeInTheDocument()
    expect(screen.queryByText(/^\d+ of \d+$/)).toBeNull()
    expect(stripAlts()).toEqual([])
  })

  it.each([['[]'], ['not json'], [undefined]])('renders nothing for gallery items %j', (items) => {
    const { container } = render(<TermulMarkdownGallery items={items} />)

    expect(container).toBeEmptyDOMElement()
  })
})
