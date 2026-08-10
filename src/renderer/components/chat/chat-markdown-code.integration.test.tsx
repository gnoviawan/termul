import { code as codePlugin } from '@streamdown/code'
import { render, waitFor } from '@testing-library/react'
import { Streamdown } from 'streamdown'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChatMarkdownCode } from './chat-markdown-code'

describe('ChatMarkdownCode with Streamdown', () => {
  it('renders non-empty and blank source lines as direct code span wrappers', async () => {
    const { container } = render(
      <TooltipProvider>
        <Streamdown
          mode="static"
          plugins={{ code: codePlugin }}
          components={{ code: ChatMarkdownCode }}
          controls={false}
          lineNumbers={false}
          linkSafety={{ enabled: false }}
        >
          {'```javascript\nconst first = 1\n\nconst third = 3\n```'}
        </Streamdown>
      </TooltipProvider>
    )

    await waitFor(() => {
      const blockBody = container.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')
      expect(blockBody).toBeInTheDocument()
      expect(blockBody).toHaveClass('[&_code>span]:block')

      const code = blockBody.querySelector('code')
      expect(code).toBeInTheDocument()

      const lineWrappers = code?.children ?? []
      expect(lineWrappers).toHaveLength(3)
      expect(lineWrappers[0]?.querySelectorAll(':scope > span').length).toBeGreaterThan(1)
      expect(lineWrappers[0]).toHaveTextContent('const first = 1')
      expect(lineWrappers[1]).toHaveTextContent(/^\s*$/)
      expect(lineWrappers[2]).toHaveTextContent('const third = 3')
    })
  })
})
