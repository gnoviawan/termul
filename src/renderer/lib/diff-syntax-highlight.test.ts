import { describe, expect, test } from 'vitest'
import { type HighlightToken, highlightLine } from './diff-syntax-highlight'

function plain(text: string): HighlightToken {
  return { text, type: 'plain' }
}

function kw(text: string): HighlightToken {
  return { text, type: 'keyword' }
}

function str(text: string): HighlightToken {
  return { text, type: 'string' }
}

function num(text: string): HighlightToken {
  return { text, type: 'number' }
}

function comment(text: string): HighlightToken {
  return { text, type: 'comment' }
}

function punct(text: string): HighlightToken {
  return { text, type: 'punctuation' }
}

describe('highlightLine', () => {
  test('highlights keywords', () => {
    expect(highlightLine('const x = 1')).toEqual([
      kw('const'),
      plain(' '),
      plain('x'),
      plain(' '),
      punct('='),
      plain(' '),
      num('1')
    ])
  })

  test('highlights return keyword', () => {
    expect(highlightLine('  return result;')).toEqual([
      plain('  '),
      kw('return'),
      plain(' '),
      plain('result'),
      punct(';')
    ])
  })

  test('highlights function keyword', () => {
    expect(highlightLine('function add(a, b) {')).toEqual([
      kw('function'),
      plain(' '),
      plain('add'),
      punct('('),
      plain('a'),
      punct(','),
      plain(' '),
      plain('b'),
      punct(')'),
      plain(' '),
      punct('{')
    ])
  })

  test('highlights double-quoted strings', () => {
    expect(highlightLine('let s = "hello world"')).toEqual([
      kw('let'),
      plain(' '),
      plain('s'),
      plain(' '),
      punct('='),
      plain(' '),
      str('"hello world"')
    ])
  })

  test('highlights single-quoted strings', () => {
    expect(highlightLine("const c = 'a'")).toEqual([
      kw('const'),
      plain(' '),
      plain('c'),
      plain(' '),
      punct('='),
      plain(' '),
      str("'a'")
    ])
  })

  test('highlights template literals', () => {
    expect(highlightLine('const s = `hello ${name}`')).toEqual([
      kw('const'),
      plain(' '),
      plain('s'),
      plain(' '),
      punct('='),
      plain(' '),
      str('`hello ${name}`')
    ])
  })

  test('highlights numbers', () => {
    expect(highlightLine('  return 42;')).toEqual([
      plain('  '),
      kw('return'),
      plain(' '),
      num('42'),
      punct(';')
    ])
  })

  test('highlights float numbers', () => {
    expect(highlightLine('  const pi = 3.14')).toEqual([
      plain('  '),
      kw('const'),
      plain(' '),
      plain('pi'),
      plain(' '),
      punct('='),
      plain(' '),
      num('3.14')
    ])
  })

  test('highlights // line comments', () => {
    expect(highlightLine('  // this is a comment')).toEqual([
      plain('  '),
      comment('// this is a comment')
    ])
  })

  test('highlights # line comments', () => {
    expect(highlightLine('# this is python')).toEqual([comment('# this is python')])
  })

  test('highlights /* block comments */', () => {
    expect(highlightLine('  /* block */ more')).toEqual([
      plain('  '),
      comment('/* block */'),
      plain(' '),
      plain('more')
    ])
  })

  test('handles empty string', () => {
    expect(highlightLine('')).toEqual([])
  })

  test('handles strings with escape sequences', () => {
    expect(highlightLine('"escaped \\" quote"')).toEqual([str('"escaped \\" quote"')])
  })

  test('highlights null/undefined/true/false as keywords', () => {
    expect(highlightLine('return null')).toEqual([kw('return'), plain(' '), kw('null')])
    expect(highlightLine('return undefined')).toEqual([kw('return'), plain(' '), kw('undefined')])
    expect(highlightLine('let a = true')).toEqual([
      kw('let'),
      plain(' '),
      plain('a'),
      plain(' '),
      punct('='),
      plain(' '),
      kw('true')
    ])
  })

  test('highlights Rust keywords', () => {
    expect(highlightLine('pub fn hello() -> String {')).toEqual([
      kw('pub'),
      plain(' '),
      kw('fn'),
      plain(' '),
      plain('hello'),
      punct('('),
      punct(')'),
      plain(' '),
      punct('-'),
      punct('>'),
      plain(' '),
      plain('String'),
      plain(' '),
      punct('{')
    ])
  })
})
