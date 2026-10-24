import { describe, expect, test } from 'bun:test'
import { splitMarkdownSections } from '../markdown-sections'

describe('splitMarkdownSections', () => {
  test('cuts at ATX and setext headings and keeps the text before the first one', () => {
    const doc = [
      'Intro line.',
      '',
      '# Alpha guide',
      'Alpha body.',
      '',
      'Setup',
      '-----',
      '- one',
      '- two'
    ].join('\n')
    expect(splitMarkdownSections(doc)).toEqual([
      { line: 0, heading: null, body: 'Intro line.\n' },
      { line: 3, heading: { level: 1, text: 'Alpha guide' }, body: 'Alpha body.\n' },
      { line: 6, heading: { level: 2, text: 'Setup' }, body: '- one\n- two' }
    ])
  })

  test('a heading inside a code fence stays in its section', () => {
    const doc = ['## Run', '```sh', '# not a heading', '```'].join('\n')
    expect(splitMarkdownSections(doc)).toEqual([
      { line: 1, heading: { level: 2, text: 'Run' }, body: '```sh\n# not a heading\n```' }
    ])
  })

  test('a document without headings is one lead section', () => {
    expect(splitMarkdownSections('just text')).toEqual([
      { line: 0, heading: null, body: 'just text' }
    ])
  })
})
