import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMPOSER_CARD_CLASS,
  COMPOSER_SURFACE_CLASS,
  NARROW_PANE_PX,
  PROMPT_PANEL_CLASS,
  resolveComposerToolbarMode
} from './chat-layout'

describe('resolveComposerToolbarMode (Story 5.1)', () => {
  it('treats non-positive widths as wide (jsdom / pre-layout default)', () => {
    expect(resolveComposerToolbarMode(0)).toBe('wide')
    expect(resolveComposerToolbarMode(-1)).toBe('wide')
  })

  it('uses narrow below the pane threshold', () => {
    expect(resolveComposerToolbarMode(399)).toBe('narrow')
    expect(resolveComposerToolbarMode(375)).toBe('narrow')
    expect(resolveComposerToolbarMode(NARROW_PANE_PX - 1)).toBe('narrow')
  })

  it('uses wide at and above the pane threshold', () => {
    expect(resolveComposerToolbarMode(NARROW_PANE_PX)).toBe('wide')
    expect(resolveComposerToolbarMode(500)).toBe('wide')
    expect(resolveComposerToolbarMode(800)).toBe('wide')
  })
})

describe('composer elevation family', () => {
  it('the composer card and prompt panels share one surface and lift through tokens', () => {
    expect(COMPOSER_CARD_CLASS).toBe(`${COMPOSER_SURFACE_CLASS} shadow-composer`)
    expect(PROMPT_PANEL_CLASS).toBe(`${COMPOSER_SURFACE_CLASS} shadow-prompt-panel`)
  })

  it.each([
    ['AskUserQuestion.tsx', 'PROMPT_PANEL_CLASS'],
    ['ElicitationPrompt.tsx', 'PROMPT_PANEL_CLASS'],
    ['ChatInputBar.tsx', 'COMPOSER_CARD_CLASS'],
    ['../agents/AgentLauncher.tsx', 'COMPOSER_CARD_CLASS']
  ])('%s takes %s and no hard-coded shadow', (file, constant) => {
    const source = readFileSync(join(__dirname, file), 'utf8')
    expect(source).toContain(constant)
    expect(source).not.toMatch(/shadow-\[|shadow-(?:sm|md|lg|xl|2xl|panel)\b|boxShadow:/)
  })
})

describe('composer edge', () => {
  it('casts no shadow or fade above the composer', () => {
    const list = readFileSync(join(__dirname, 'ChatMessageList.tsx'), 'utf8')
    expect(list).not.toMatch(/bg-gradient-to-t/)
    expect(list).not.toMatch(/bottom-0[^"]*bg-gradient/)
    expect(COMPOSER_CARD_CLASS).toContain('shadow-composer')
  })
})
