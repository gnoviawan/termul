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
  it('renders unordered lists with li elements', () => {
    const html = renderChatMarkdown('- item one\n- item two\n- item three')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>')
    expect(html).toContain('item one')
    expect(html).toContain('item two')
    expect(html).toContain('item three')
  })
  it('renders ordered lists with li elements', () => {
    const html = renderChatMarkdown('1. first\n2. second\n3. third')
    expect(html).toContain('<ol>')
    expect(html).toContain('<li>')
    expect(html).toContain('first')
    expect(html).toContain('second')
    expect(html).toContain('third')
  })
  it('renders nested lists', () => {
    const html = renderChatMarkdown('- parent\n  - child one\n  - child two')
    expect(html).toContain('<ul>')
    expect(html).toContain('parent')
    expect(html).toContain('child one')
  })
})
