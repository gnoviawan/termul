import { describe, expect, it } from 'vitest'
import { renderChatMarkdown } from './chat-markdown'

describe('renderChatMarkdown', () => {
  it('renders markdown', () => {
    const html = renderChatMarkdown('# Hi\n\n**bold** and `code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
  })
  it('strips scripts', () => {
    const html = renderChatMarkdown('hi <script>alert(1)</script>')
    expect(html).not.toContain('<script>')
  })
})
