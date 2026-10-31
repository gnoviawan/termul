import { describe, expect, it } from 'vitest'
import { plainPreview } from './plain-preview'

describe('plainPreview', () => {
  it('reduces a CodeRabbit thread opener to its words', () => {
    const body = [
      '<!-- coderabbit-ai-generated:v1 -->',
      '',
      '**<picture><img src="https://x/amber-16.svg" alt=""></picture> Minor** · **Functional Correctness**',
      '',
      '<details>',
      '<summary>Supported by static analysis</summary>',
      '```bash',
      'rg -n foo',
      '```',
      '</details>',
      '',
      '_Guard the [empty list](https://example.com/a) before indexing._'
    ].join('\n')
    expect(plainPreview(body)).toBe(
      'Minor · Functional Correctness Guard the empty list before indexing.'
    )
  })

  it('leaves plain prose alone', () => {
    expect(plainPreview('Rename this to `count`.')).toBe('Rename this to count.')
  })
})
