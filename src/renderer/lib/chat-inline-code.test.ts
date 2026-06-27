import { describe, expect, it } from 'vitest'
import { inlineCodeClass } from './chat-inline-code'

describe('inlineCodeClass', () => {
  it('classifies paths with slashes', () => {
    expect(inlineCodeClass('src/foo.ts')).toBe('chat-code-path')
    expect(inlineCodeClass('app/')).toBe('chat-code-path')
  })

  it('classifies paths with backslashes', () => {
    expect(inlineCodeClass('src\\components')).toBe('chat-code-path')
  })

  it('classifies file-extension suffixes', () => {
    expect(inlineCodeClass('index.tsx')).toBe('chat-code-path')
    expect(inlineCodeClass('Cargo.toml')).toBe('chat-code-path')
  })

  it('classifies plain tokens', () => {
    expect(inlineCodeClass('Next.js')).toBe('chat-code-token')
    expect(inlineCodeClass('React 19')).toBe('chat-code-token')
    expect(inlineCodeClass('useState')).toBe('chat-code-token')
  })

  it('treats empty text as token', () => {
    expect(inlineCodeClass('')).toBe('chat-code-token')
    expect(inlineCodeClass('   ')).toBe('chat-code-token')
  })
})
