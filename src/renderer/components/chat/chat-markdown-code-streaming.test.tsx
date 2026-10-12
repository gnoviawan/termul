import { code as shikiCodePlugin } from '@streamdown/code'
import { act, render, waitFor } from '@testing-library/react'
import { Streamdown } from 'streamdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentProse } from './chat-agent-prose'
import { chatCodePlugin } from './chat-code-plugin'
import { ChatMarkdownCode, OPEN_FENCE_HIGHLIGHT_MAX_CHARS } from './chat-markdown-code'

function fenceBody(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `const value${i} = compute(${i}) // line ${i}`
  ).join('\n')
}

function renderChat(text: string, streaming: boolean) {
  const ui = (value: string, isStreaming: boolean) => (
    <TooltipProvider>
      <Streamdown
        mode={isStreaming ? 'streaming' : 'static'}
        isAnimating={isStreaming}
        parseIncompleteMarkdown={isStreaming}
        plugins={{ code: chatCodePlugin }}
        components={{ code: ChatMarkdownCode }}
        controls={false}
        lineNumbers={false}
        linkSafety={{ enabled: false }}
      >
        {value}
      </Streamdown>
    </TooltipProvider>
  )
  const view = render(ui(text, streaming))
  return {
    ...view,
    update: (value: string, isStreaming: boolean) => view.rerender(ui(value, isStreaming))
  }
}

describe('streaming code fences', () => {
  afterEach(() => vi.restoreAllMocks())

  it('never highlights a partial oversized open fence across stream ticks, then highlights the full body once at close', async () => {
    const highlight = vi.spyOn(shikiCodePlugin, 'highlight')
    const body = fenceBody(Math.ceil(OPEN_FENCE_HIGHLIGHT_MAX_CHARS / 40) + 40)
    expect(body.length).toBeGreaterThan(OPEN_FENCE_HIGHLIGHT_MAX_CHARS)
    // Every stage is already past the live-highlight bound.
    const first = Math.floor(OPEN_FENCE_HIGHLIGHT_MAX_CHARS * 1.1)
    expect(first).toBeLessThan(body.length)

    // Let each commit settle through React's effects and any async highlight
    // scheduling before the next tokens arrive.
    const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 150)))

    const view = renderChat(`\`\`\`ts\n${body.slice(0, first)}`, true)
    await settle()
    const stages = [
      first,
      ...[0.5, 0.7, 0.85, 1].map((f) => Math.floor(first + (body.length - first) * f))
    ]
    for (const end of stages.slice(1)) {
      view.update(`\`\`\`ts\n${body.slice(0, end)}`, true)
      await settle()
    }
    // Several commits of a still-open, oversized fence: the highlighter never
    // saw any (partial) source of it.
    expect(highlight.mock.calls.map(([options]) => options.code.length)).toEqual([])
    expect(
      view.container.querySelector('[data-streamdown="code-block-body"]')?.textContent
    ).toContain('line 0')

    // The fence closes and the message settles: exactly the full body, once.
    view.update(`\`\`\`ts\n${body}\n\`\`\``, false)
    await waitFor(() => expect(highlight).toHaveBeenCalled(), { timeout: 15_000 })
    await settle()
    expect(highlight).toHaveBeenCalledTimes(1)
    const [options] = highlight.mock.calls[0]
    expect(options.language).toBe('ts')
    expect(options.code).toBe(body)
  }, 30_000)

  it('AgentProse (the real chat renderer) never highlights a partial oversized open fence, then highlights the full body once at close', async () => {
    const highlight = vi.spyOn(shikiCodePlugin, 'highlight')
    const body = fenceBody(Math.ceil(OPEN_FENCE_HIGHLIGHT_MAX_CHARS / 40) + 40)
    const first = Math.floor(OPEN_FENCE_HIGHLIGHT_MAX_CHARS * 1.1)
    // The streaming text is throttled (10 Hz trailing edge): settle past it.
    const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 250)))
    const ui = (value: string, streaming: boolean) => (
      <TooltipProvider>
        <AgentProse text={value} streaming={streaming} reduced />
      </TooltipProvider>
    )

    const view = render(ui(`\`\`\`ts\n${body.slice(0, first)}`, true))
    await settle()
    for (const f of [0.5, 0.7, 0.85, 1]) {
      const end = Math.floor(first + (body.length - first) * f)
      view.rerender(ui(`\`\`\`ts\n${body.slice(0, end)}`, true))
      await settle()
    }
    expect(highlight.mock.calls.map(([options]) => options.code.length)).toEqual([])
    expect(
      view.container.querySelector('[data-streamdown="code-block-body"]')?.textContent
    ).toContain('line 0')

    view.rerender(ui(`\`\`\`ts\n${body}\n\`\`\``, false))
    await waitFor(() => expect(highlight).toHaveBeenCalled(), { timeout: 15_000 })
    await settle()
    expect(highlight).toHaveBeenCalledTimes(1)
    const [options] = highlight.mock.calls[0]
    expect(options.language).toBe('ts')
    expect(options.code).toBe(body)
  }, 30_000)

  it('keeps live highlighting for a small open fence', async () => {
    const highlight = vi.spyOn(shikiCodePlugin, 'highlight')
    renderChat(`\`\`\`ts\n${fenceBody(5)}`, true)
    await waitFor(() => expect(highlight).toHaveBeenCalled(), { timeout: 15_000 })
    expect(highlight.mock.calls[0][0].language).toBe('ts')
  })
})

describe('chatCodePlugin', () => {
  it.each(['text', 'TXT', 'plaintext'])('skips the highlighter for %s blocks', (language) => {
    const highlight = vi.spyOn(shikiCodePlugin, 'highlight')
    const callback = vi.fn()
    expect(
      chatCodePlugin.highlight(
        { code: 'a', language, themes: ['github-light', 'github-dark'] },
        callback
      )
    ).toBeNull()
    expect(highlight).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    highlight.mockRestore()
  })
})
