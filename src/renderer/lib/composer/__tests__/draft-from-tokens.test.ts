import { describe, expect, it } from 'vitest'
import { CMD_PILL_NODE, SKILL_PILL_NODE } from '@/lib/composer/doc-to-prompt'
import { draftFromTokens } from '@/lib/composer/draft-from-tokens'
import {
  CMD_TOKEN_END,
  CMD_TOKEN_START,
  SKILL_PAD_END,
  SKILL_PAD_START,
  SKILL_TOKEN_END,
  SKILL_TOKEN_START
} from '@/lib/skill-tokens'

const pill = (name: string, path = '') => ({ type: SKILL_PILL_NODE, attrs: { name, path } })
const cmdPill = (name: string) => ({ type: CMD_PILL_NODE, attrs: { name } })
const text = (t: string) => ({ type: 'text', text: t })
const para = (content?: unknown[]) => ({ type: 'paragraph', content })

describe('draftFromTokens', () => {
  it('emits a single empty paragraph for the empty-value case (valid editable doc)', () => {
    expect(draftFromTokens('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it('preserves whitespace-only input as a text node (whitespace is text, not empty)', () => {
    expect(draftFromTokens('   ')).toEqual({
      type: 'doc',
      content: [para([text('   ')])]
    })
  })

  it('passes plain text through as a single text node (no skills, no tokens)', () => {
    expect(draftFromTokens('hello world')).toEqual({
      type: 'doc',
      content: [para([text('hello world')])]
    })
  })

  it('parses a sentinel skill token into a skillPill node (resume-draft happy path)', () => {
    const value = `${SKILL_TOKEN_START}acp${SKILL_TOKEN_END}`
    expect(draftFromTokens(value)).toEqual({
      type: 'doc',
      content: [para([pill('acp')])]
    })
  })

  it('seeds the pill path attr from the optional paths map when the name matches', () => {
    const value = `${SKILL_TOKEN_START}acp${SKILL_TOKEN_END}`
    expect(draftFromTokens(value, { acp: '/abs/SKILL.md' })).toEqual({
      type: 'doc',
      content: [para([pill('acp', '/abs/SKILL.md')])]
    })
  })

  it('drops the obsolete padding block when parsing a token (pill is a real DOM node)', () => {
    const value = `${SKILL_TOKEN_START}acp${SKILL_TOKEN_END}${SKILL_PAD_START}   ${SKILL_PAD_END}`
    expect(draftFromTokens(value)).toEqual({
      type: 'doc',
      content: [para([pill('acp')])]
    })
  })

  it('intersperses text and pills preserving order (mid-text skill)', () => {
    const value = `fix the ${SKILL_TOKEN_START}bug${SKILL_TOKEN_END} now`
    expect(draftFromTokens(value)).toEqual({
      type: 'doc',
      content: [para([text('fix the '), pill('bug'), text(' now')])]
    })
  })

  it('treats a malformed (unclosed) token as plain text so a corrupted draft still loads', () => {
    const value = `${SKILL_TOKEN_START}acp without close`
    const doc = draftFromTokens(value)
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].content).toEqual([text(`${SKILL_TOKEN_START}acp without close`)])
  })

  it('treats an empty-name token as plain text (degrades gracefully, no pill)', () => {
    // An empty-name token (\uE000\uE001) is not recognized as a skill; the raw
    // sentinel chars fall through as plain text so the editor still loads.
    const value = `${SKILL_TOKEN_START}${SKILL_TOKEN_END}`
    const doc = draftFromTokens(value)
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].content).toEqual([text(value)])
    expect(doc.content[0].content![0].type).toBe('text')
  })

  it('splits on newlines into multiple paragraphs (matches pre-refactor textarea Enter behavior)', () => {
    const value = `line1\n${SKILL_TOKEN_START}acp${SKILL_TOKEN_END}\nline3`
    expect(draftFromTokens(value)).toEqual({
      type: 'doc',
      content: [para([text('line1')]), para([pill('acp')]), para([text('line3')])]
    })
  })

  it('round-trips a multi-paragraph value back to the same display string (patch 11 boundary handling)', () => {
    // draftFromTokens only ever creates paragraphs (no hardBreak nodes) — a
    // trailing-hardBreak + next-paragraph doc only arises from Shift+Enter.
    // This locks the parser side: `\n`-separated lines parse to N paragraphs,
    // and `docToDisplayText` of those N paragraphs re-emits N-1 `\n` (one
    // boundary between each pair, no trailing). The full round-trip (with the
    // editor's docToDisplayText) is covered in ChatComposerEditor.test.tsx.
    const value = `line1\n${SKILL_TOKEN_START}acp${SKILL_TOKEN_END}\nline3`
    const doc = draftFromTokens(value)
    expect(doc.content).toHaveLength(3)
    expect(doc.content[0]).toEqual(para([text('line1')]))
    expect(doc.content[1]).toEqual(para([pill('acp')]))
    expect(doc.content[2]).toEqual(para([text('line3')]))
  })

  it('round-trips paste of a draft carrying mixed tokens back into pill nodes (matrix row 5: paste)', () => {
    const pasted = `ship the ${SKILL_TOKEN_START}feature${SKILL_TOKEN_END} after ${SKILL_TOKEN_START}tests${SKILL_TOKEN_END}`
    expect(draftFromTokens(pasted)).toEqual({
      type: 'doc',
      content: [para([text('ship the '), pill('feature'), text(' after '), pill('tests')])]
    })
  })

  it('leaves an unparsable garbage string intact as plain text', () => {
    const garbage = '\uE000no-close-here and \uE002 dangling pad'
    const doc = draftFromTokens(garbage)
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].content).toEqual([text(garbage)])
  })

  // ----- Command pill (CAP — Inline command pill) -----

  it('parses a command sentinel token into a commandPill node', () => {
    const value = `${CMD_TOKEN_START}compact${CMD_TOKEN_END}`
    expect(draftFromTokens(value)).toEqual({
      type: 'doc',
      content: [para([cmdPill('compact')])]
    })
  })

  it('intersperses command pill + text + skill pill (mixed sentinels)', () => {
    const value = `${CMD_TOKEN_START}compact${CMD_TOKEN_END} then ${SKILL_TOKEN_START}acp${SKILL_TOKEN_END} after`
    expect(draftFromTokens(value)).toEqual({
      type: 'doc',
      content: [para([cmdPill('compact'), text(' then '), pill('acp'), text(' after')])]
    })
  })

  it('treats a malformed (unclosed) command token as plain text', () => {
    const value = `${CMD_TOKEN_START}compact without close`
    const doc = draftFromTokens(value)
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].content).toEqual([text(`${CMD_TOKEN_START}compact without close`)])
  })

  it('treats an empty-name command token as plain text (no pill)', () => {
    const value = `${CMD_TOKEN_START}${CMD_TOKEN_END}`
    const doc = draftFromTokens(value)
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].content).toEqual([text(value)])
    expect(doc.content[0].content![0].type).toBe('text')
  })
})
