import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { filterTocHeadings, parseMarkdownHeadings, useTocHeadings } from './use-toc-headings'

describe('use-toc-headings', () => {
  it('parses markdown headings with levels and line numbers', () => {
    const headings = parseMarkdownHeadings(['# Title', 'text', '## Section', '### Subsection'].join('\n'))

    expect(headings).toEqual([
      { id: 'heading-line-1', level: 1, text: 'Title', line: 1 },
      { id: 'heading-line-3', level: 2, text: 'Section', line: 3 },
      { id: 'heading-line-4', level: 3, text: 'Subsection', line: 4 }
    ])
  })

  it('supports indented atx headings, trailing closing hashes, and setext headings', () => {
    const headings = parseMarkdownHeadings(
      ['  ## Section ##', 'Title', '====', 'Subtitle', '----'].join('\n')
    )

    expect(headings).toEqual([
      { id: 'heading-line-1', level: 2, text: 'Section', line: 1 },
      { id: 'heading-line-2', level: 1, text: 'Title', line: 2 },
      { id: 'heading-line-4', level: 2, text: 'Subtitle', line: 4 }
    ])
  })

  it('does not duplicate atx headings when followed by setext markers', () => {
    expect(parseMarkdownHeadings(['# Title', '---', '## Section', '==='].join('\n'))).toEqual([
      { id: 'heading-line-1', level: 1, text: 'Title', line: 1 },
      { id: 'heading-line-3', level: 2, text: 'Section', line: 3 }
    ])
  })

  it('ignores non-heading lines and headings inside fenced code blocks', () => {
    expect(parseMarkdownHeadings('plain text\n- list item\n```md\n# Hidden\n```\n# Visible')).toEqual([
      { id: 'heading-line-6', level: 1, text: 'Visible', line: 6 }
    ])
  })

  it('filters headings by max level', () => {
    const headings = parseMarkdownHeadings('# Title\n## Section\n### Deep')

    expect(filterTocHeadings(headings, 2)).toEqual([
      { id: 'heading-line-1', level: 1, text: 'Title', line: 1 },
      { id: 'heading-line-2', level: 2, text: 'Section', line: 2 }
    ])
  })

  it('memoizes filtered headings in the hook', () => {
    const { result, rerender } = renderHook(
      ({ content, maxLevel }) => useTocHeadings({ content, maxLevel }),
      {
        initialProps: {
          content: '# Title\n## Section\n### Deep',
          maxLevel: 2
        }
      }
    )

    expect(result.current.headings).toHaveLength(2)

    rerender({
      content: '# Title\n## Section\n### Deep',
      maxLevel: 3
    })

    expect(result.current.headings).toHaveLength(3)
  })
})
