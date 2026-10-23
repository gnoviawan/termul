import { describe, expect, test } from 'bun:test'
import { Node, Schema } from '@tiptap/pm/model'
import { docToDisplayText } from '@/lib/composer/doc-to-prompt'
import { draftFromTokens } from '@/lib/composer/draft-from-tokens'
import {
  insertCommandToken,
  insertFileToken,
  insertSkillToken,
  replaceCommandTokensInline,
  replaceFileTokensInline
} from '@/lib/skill-tokens'
import { formatPromptWithSkills } from '@/lib/skills-prompt'
import {
  type ComposerDoc,
  deleteBackward,
  deleteForward,
  fromDisplay,
  fromDisplayOffset,
  insertText,
  moveCaret,
  project,
  replaceRange,
  toDisplay,
  toDisplayOffset
} from '../model'
import { diffTexts, reconcile } from '../reconcile'

const FILE = 'app.ts\u001F/repo/src/app.ts'
const CMD = 'compact'
const SKILL = 'review '

const app = { kind: 'file', display: 'app.ts', absPath: '/repo/src/app.ts' } as const
const compact = { kind: 'command', name: 'compact' } as const
const review = { kind: 'skill', name: 'review' } as const

/** Same node names and attrs as the web's SkillPill / CommandPill / FilePill extensions. */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    skillPill: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { name: { default: '' }, path: { default: '' } }
    },
    commandPill: { group: 'inline', inline: true, atom: true, attrs: { name: { default: '' } } },
    filePill: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { display: { default: '' }, absPath: { default: '' } }
    }
  }
})

function typeAll(
  doc: ComposerDoc,
  caret: number,
  text: string
): { doc: ComposerDoc; caret: number } {
  let state = { doc, caret }
  for (const ch of text) state = insertText(state.doc, state.caret, ch)
  return state
}

describe('display string', () => {
  test('parses pills with the web parser and serializes them back byte for byte', () => {
    const value = `fix ${FILE} then ${CMD} with ${SKILL} done\nline two`
    const doc = fromDisplay(value)
    expect(doc).toEqual([
      { kind: 'text', text: 'fix ' },
      app,
      { kind: 'text', text: ' then ' },
      compact,
      { kind: 'text', text: ' with ' },
      review,
      { kind: 'text', text: ' done\nline two' }
    ])
    expect(toDisplay(doc)).toBe(value)
  })

  test('projects pills to labels the textarea shows', () => {
    expect(project(fromDisplay(`fix ${FILE} ${CMD}`))).toEqual({
      text: 'fix @app.ts /compact',
      pills: [
        { from: 4, to: 11, pill: app },
        { from: 12, to: 20, pill: compact }
      ]
    })
  })

  test('maps caret offsets between the projection and the display string', () => {
    const doc = fromDisplay(`a ${FILE} b`)
    expect(toDisplayOffset(doc, 2)).toBe(2)
    expect(toDisplayOffset(doc, 9)).toBe(2 + FILE.length)
    expect(toDisplayOffset(doc, 5)).toBe(2 + FILE.length)
    expect(toDisplayOffset(doc, 11)).toBe(4 + FILE.length)
    expect(fromDisplayOffset(doc, 3 + FILE.length)).toBe(10)
    expect(fromDisplayOffset(doc, 6)).toBe(9)
  })
})

describe('editing', () => {
  test('typing builds text and the display string', () => {
    const typed = typeAll([], 0, 'hello')
    expect(typed).toEqual({ doc: [{ kind: 'text', text: 'hello' }], caret: 5 })
    expect(toDisplay(typed.doc)).toBe('hello')
  })

  test('a newline is a newline in the display string', () => {
    const state = insertText(fromDisplay('ab'), 1, '\n')
    expect(state).toEqual({ doc: [{ kind: 'text', text: 'a\nb' }], caret: 2 })
    expect(toDisplay(state.doc)).toBe('a\nb')
  })

  test('a mention pick through the shared splice becomes a file pill', () => {
    const picked = insertFileToken('see @ap', 7, 'app.ts', '/repo/src/app.ts', 3)
    const doc = fromDisplay(picked.value)
    expect(doc).toEqual([{ kind: 'text', text: 'see ' }, app, { kind: 'text', text: ' ' }])
    expect(project(doc).text).toBe('see @app.ts ')
    expect(fromDisplayOffset(doc, picked.caret)).toBe(12)
  })

  test('a slash command and a skill pick become pills', () => {
    const cmd = insertCommandToken('/com', 4, 'compact', 4)
    if (!cmd.inserted) throw new Error('command rejected')
    const skill = insertSkillToken(`${cmd.value}/rev`, cmd.value.length + 4, 'review', 4, ' ')
    const doc = fromDisplay(skill.value)
    expect(doc).toEqual([compact, { kind: 'text', text: ' ' }, review, { kind: 'text', text: ' ' }])
    expect(skill.value).toBe(`${CMD} ${SKILL} `)
    expect(project(doc).text).toBe('/compact /review ')
  })

  test('Backspace after a pill removes the whole pill', () => {
    const doc = fromDisplay(`see ${FILE}`)
    expect(deleteBackward(doc, 11)).toEqual({ doc: [{ kind: 'text', text: 'see ' }], caret: 4 })
  })

  test('Backspace after the space that follows a pill removes both, like the web keymap', () => {
    const doc = fromDisplay(`see ${FILE} `)
    expect(deleteBackward(doc, 12)).toEqual({ doc: [{ kind: 'text', text: 'see ' }], caret: 4 })
  })

  test('Delete before a pill removes the whole pill', () => {
    const doc = fromDisplay(`${CMD} go`)
    expect(deleteForward(doc, 0)).toEqual({ doc: [{ kind: 'text', text: ' go' }], caret: 0 })
  })

  test('arrows step over a pill in one move', () => {
    const doc = fromDisplay(`a${FILE}b`)
    expect(moveCaret(doc, 1, 1)).toBe(8)
    expect(moveCaret(doc, 8, -1)).toBe(1)
    expect(moveCaret(doc, 4, 1)).toBe(8)
  })

  test('a selection across part of a pill removes the pill', () => {
    const doc = fromDisplay(`ab ${FILE} cd`)
    expect(replaceRange(doc, 1, 6, 'X')).toEqual({
      doc: [{ kind: 'text', text: 'aX cd' }],
      caret: 2
    })
  })

  test('typing inside a pill label lands after the pill', () => {
    const doc = fromDisplay(`${FILE}!`)
    expect(insertText(doc, 3, 'z')).toEqual({ doc: [app, { kind: 'text', text: 'z!' }], caret: 8 })
  })

  test('pasting a display string with tokens pastes pills', () => {
    const state = insertText(fromDisplay('x'), 1, ` ${FILE}\ny`)
    expect(state).toEqual({
      doc: [{ kind: 'text', text: 'x ' }, app, { kind: 'text', text: '\ny' }],
      caret: 11
    })
  })
})

describe('native textarea edits', () => {
  test('diff reads typing and Backspace at the known caret', () => {
    expect(diffTexts('aa', 'aaa', 1)).toEqual({ from: 1, to: 1, inserted: 'a' })
    expect(diffTexts('abb', 'ab', 2)).toEqual({ from: 1, to: 2, inserted: '' })
    expect(diffTexts('abb', 'ab', 1)).toEqual({ from: 1, to: 2, inserted: '' })
    expect(diffTexts('hello', 'help!', null)).toEqual({ from: 3, to: 5, inserted: 'p!' })
  })

  test('native Backspace at the end of a label removes the pill and rewrites the text', () => {
    const doc = fromDisplay(`see ${FILE} now`)
    expect(reconcile(doc, 'see @app.ts now', 'see @app.t now', 11)).toEqual({
      doc: [{ kind: 'text', text: 'see  now' }],
      caret: 4,
      text: 'see  now'
    })
  })

  test('native Backspace over the space after a pill removes the pill', () => {
    const doc = fromDisplay(`see ${FILE} `)
    expect(reconcile(doc, 'see @app.ts ', 'see @app.ts', 12)).toEqual({
      doc: [{ kind: 'text', text: 'see ' }],
      caret: 4,
      text: 'see '
    })
  })

  test('native paste of plain text keeps pills in place', () => {
    const doc = fromDisplay(`${FILE} `)
    const next = reconcile(doc, '@app.ts ', '@app.ts two\nlines', 8)
    expect(next).toEqual({
      doc: [app, { kind: 'text', text: ' two\nlines' }],
      caret: 17,
      text: '@app.ts two\nlines'
    })
    expect(toDisplay(next.doc)).toBe(`${FILE} two\nlines`)
  })
})

describe('prompt parity with the web composer', () => {
  const tiptap = {
    type: 'doc' as const,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'commandPill', attrs: { name: 'compact' } },
          { type: 'text', text: ' read ' },
          { type: 'filePill', attrs: { display: 'app.ts', absPath: '/repo/src/app.ts' } },
          { type: 'text', text: ' with ' },
          { type: 'skillPill', attrs: { name: 'review', path: '' } }
        ]
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'second line' }] }
    ]
  }
  const native: ComposerDoc = [
    compact,
    { kind: 'text', text: ' read ' },
    app,
    { kind: 'text', text: ' with ' },
    review,
    { kind: 'text', text: '\nsecond line' }
  ]

  test('the native doc serializes to what docToDisplayText makes of the same tiptap JSON', () => {
    const web = docToDisplayText(Node.fromJSON(schema, tiptap))
    expect(toDisplay(native)).toBe(web)
    expect(web).toBe(`${CMD} read ${FILE} with ${SKILL}\nsecond line`)
    expect(draftFromTokens(toDisplay(native))).toEqual(tiptap)
  })

  test('the wire text built from it is the literal prompt the agent gets', () => {
    const wire = formatPromptWithSkills(
      [{ name: 'review', path: '/skills/review/SKILL.md' }],
      replaceFileTokensInline(replaceCommandTokensInline(toDisplay(native)))
    )
    expect(wire).toBe(
      '# Agent Skills\n\nreview: /skills/review/SKILL.md\n\n---\n\n/compact read (app.ts) with (review)\nsecond line'
    )
  })
})
