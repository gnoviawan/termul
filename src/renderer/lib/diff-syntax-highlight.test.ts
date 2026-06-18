import { describe, expect, it } from 'vitest'
import { getLanguageForFile, isParserReady, tokenizeLine } from './diff-syntax-highlight'

describe('getLanguageForFile', () => {
  it('maps .ts to typescript', () => {
    expect(getLanguageForFile('src/foo.ts')).toBe('typescript')
  })

  it('maps .tsx to typescript', () => {
    expect(getLanguageForFile('src/foo.tsx')).toBe('typescript')
  })

  it('maps .js to javascript', () => {
    expect(getLanguageForFile('script.js')).toBe('javascript')
  })

  it('maps .py to python', () => {
    expect(getLanguageForFile('script.py')).toBe('python')
  })

  it('maps .rs to rust', () => {
    expect(getLanguageForFile('main.rs')).toBe('rust')
  })

  it('maps .css to css', () => {
    expect(getLanguageForFile('style.css')).toBe('css')
  })

  it('maps .json to json', () => {
    expect(getLanguageForFile('config.json')).toBe('json')
  })

  it('maps .yaml to yaml', () => {
    expect(getLanguageForFile('config.yaml')).toBe('yaml')
  })

  it('maps .yml to yaml', () => {
    expect(getLanguageForFile('config.yml')).toBe('yaml')
  })

  it('maps .md to markdown', () => {
    expect(getLanguageForFile('README.md')).toBe('markdown')
  })

  it('maps .html to html', () => {
    expect(getLanguageForFile('index.html')).toBe('html')
  })

  it('returns empty string for unknown extension', () => {
    expect(getLanguageForFile('data.xyz')).toBe('')
  })

  it('returns empty string for no extension', () => {
    expect(getLanguageForFile('Makefile')).toBe('')
  })

  it('handles Windows-style paths', () => {
    expect(getLanguageForFile('src\\components\\Foo.ts')).toBe('typescript')
  })
})

describe('tokenizeLine', () => {
  it('returns empty array for empty text', () => {
    expect(tokenizeLine('', 'typescript')).toEqual([])
  })

  it('returns empty array for empty language', () => {
    expect(tokenizeLine('const x = 1', '')).toEqual([])
  })

  it('returns empty array when parser is not loaded', () => {
    // Parser for 'typescript' is not preloaded in test env
    const result = tokenizeLine('const x = 1', 'typescript')
    // Without preloading, should return empty (no crash)
    expect(result).toEqual([])
  })
})

describe('isParserReady', () => {
  it('returns false for unloaded language', () => {
    expect(isParserReady('typescript')).toBe(false)
  })

  it('returns false for empty language', () => {
    expect(isParserReady('')).toBe(false)
  })
})
