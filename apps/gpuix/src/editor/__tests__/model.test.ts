import { describe, expect, test } from 'bun:test'
import { javascript } from '@codemirror/lang-javascript'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { chunksBetween, chunkStarts } from '../chunks'
import { keyIntent } from '../keymap'
import {
  caretLineCol,
  createModel,
  type EditorCommand,
  type EditorModel,
  execute,
  posAtLineCol,
  replaceDocument,
  selectedText
} from '../model'

const ctx = { pageLines: 10 }
const run = (model: EditorModel, ...commands: EditorCommand[]) =>
  commands.reduce((m, c) => execute(m, c, ctx), model)
const key = (model: EditorModel, k: string, mods: Record<string, boolean> = {}, keyChar?: string) => {
  const intent = keyIntent({ key: k, keyChar: keyChar ?? (k.length === 1 ? k : undefined), modifiers: mods })
  if (intent?.kind !== 'edit') throw new Error(`${k} is not an edit: ${JSON.stringify(intent)}`)
  return execute(model, intent.command, ctx)
}
const at = (model: EditorModel, line: number, col: number) =>
  run(model, { kind: 'cursor', pos: posAtLineCol(model.state, line, col), extend: false })

describe('editor model', () => {
  test('typing at line 3 col 5 inserts there and moves the caret', () => {
    let m = at(createModel('one\ntwo\nthree four\n'), 3, 5)
    for (const ch of 'XY') m = key(m, ch)
    expect(m.state.doc.line(3).text).toBe('threXYe four')
    expect(caretLineCol(m.state)).toEqual({ line: 3, col: 7 })
  })

  test('undo reverts a typed run and redo restores it', () => {
    let m = at(createModel('abc'), 1, 4)
    for (const ch of 'def') m = key(m, ch)
    expect(m.state.doc.toString()).toBe('abcdef')
    m = key(m, 'z', { ctrl: true })
    expect(m.state.doc.toString()).toBe('abc')
    m = key(m, 'y', { ctrl: true })
    expect(m.state.doc.toString()).toBe('abcdef')
  })

  test('Enter keeps the indentation of the language', () => {
    let m = createModel('function f() {}', [javascript()])
    m = at(m, 1, 15)
    m = key(m, 'enter')
    expect(m.state.doc.toString()).toBe('function f() {\n  \n}')
    expect(caretLineCol(m.state)).toEqual({ line: 2, col: 3 })
  })

  test('Backspace at a line start joins lines; Delete at the end joins forward', () => {
    let m = at(createModel('ab\ncd'), 2, 1)
    m = key(m, 'backspace')
    expect(m.state.doc.toString()).toBe('abcd')
    m = at(createModel('ab\ncd'), 1, 3)
    m = key(m, 'delete')
    expect(m.state.doc.toString()).toBe('abcd')
  })

  test('vertical moves keep the goal column across a short line', () => {
    let m = at(createModel('abcdef\nx\nabcdef'), 1, 6)
    m = key(m, 'down')
    expect(caretLineCol(m.state)).toEqual({ line: 2, col: 2 })
    m = key(m, 'down')
    expect(caretLineCol(m.state)).toEqual({ line: 3, col: 6 })
  })

  test('Home goes to the indentation, then to the line start', () => {
    let m = at(createModel('    code'), 1, 7)
    m = key(m, 'home')
    expect(caretLineCol(m.state)).toEqual({ line: 1, col: 5 })
    m = key(m, 'home')
    expect(caretLineCol(m.state)).toEqual({ line: 1, col: 1 })
  })

  test('shift-motion selects; ctrl-right jumps a word', () => {
    let m = at(createModel('hello world'), 1, 1)
    m = key(m, 'right', { ctrl: true })
    expect(caretLineCol(m.state)).toEqual({ line: 1, col: 6 })
    m = key(m, 'end', { shift: true })
    expect(selectedText(m)).toBe(' world')
  })

  test('Tab indents the line by the indent unit; Shift-Tab dedents', () => {
    let m = at(createModel('x'), 1, 1)
    m = key(m, 'tab')
    expect(m.state.doc.toString()).toBe('  x')
    m = key(m, 'tab', { shift: true })
    expect(m.state.doc.toString()).toBe('x')
  })

  test('an external reload replaces the text outside the undo history', () => {
    let m = key(at(createModel('a'), 1, 2), 'b')
    m = replaceDocument(m, 'reloaded')
    expect(m.state.doc.toString()).toBe('reloaded')
    m = key(m, 'z', { ctrl: true })
    expect(m.state.doc.toString()).toBe('reloaded')
  })

  test('app shortcuts the editor does not own come back as null', () => {
    expect(keyIntent({ key: 'k', modifiers: { ctrl: true } })).toBeNull()
    expect(keyIntent({ key: 'w', modifiers: { ctrl: true } })).toBeNull()
    expect(keyIntent({ key: 's', modifiers: { ctrl: true } })).toEqual({ kind: 'save' })
  })

  test('a read-only state refuses typing and deletion', () => {
    let m = at(createModel('abc', [EditorState.readOnly.of(true)]), 1, 2)
    m = key(m, 'x')
    m = key(m, 'backspace')
    expect(m.state.doc.toString()).toBe('abc')
  })
})

describe('chunks', () => {
  test('a boundary moves past a block comment that covers it', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}`)
    lines[62] = '/* start'
    for (let i = 63; i < 70; i++) lines[i] = ` comment ${i}`
    lines[70] = '*/'
    const m = createModel(lines.join('\n'), [javascript()])
    ensureSyntaxTree(m.state, m.state.doc.length, 5000)
    const starts = chunkStarts(m.state)
    expect(starts[0]).toBe(1)
    expect(starts[1]).toBe(72)
    expect(chunksBetween(starts, 200, 70, 80)).toEqual([
      { startLine: 1, endLine: 71 },
      { startLine: 72, endLine: 135 }
    ])
  })
})
