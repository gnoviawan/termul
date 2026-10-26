import { describe, expect, it } from 'vitest'
import { selectionContextToken, serializeSelectionContexts } from '@/lib/composer/selection-context'
import { commandToken, replaceCommandTokensInline } from '@/lib/skill-tokens'
import { isPersistedTwin } from './helpers'
import type { ChatMessage } from './index'

function user(id: string, text: string): ChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], streaming: false, timestamp: 0 }
}

function wireOf(display: string): string {
  return replaceCommandTokensInline(serializeSelectionContexts(display)).trim()
}

const ctx = selectionContextToken({ text: 'line one\nline two' })

describe('persisted/live twin with selection contexts', () => {
  it('matches the live chip message with its persisted prompt', () => {
    const display = `Explain ${ctx} please`
    expect(isPersistedTwin(user('p', wireOf(display)), user('l', display), false)).toBe(true)
  })

  it('matches when a command pill touches a context pill (no space to restore)', () => {
    const display = `${commandToken('review')}${ctx} focus`
    expect(isPersistedTwin(user('p', wireOf(display)), user('l', display), false)).toBe(true)
  })

  it('matches a typed message that has the exact prompt shape', () => {
    const typed = 'Context 1 (selected from the conversation):\n> x\n\n[Context 1] why'
    expect(isPersistedTwin(user('p', typed), user('l', typed), false)).toBe(true)
  })

  it('still tells different contexts apart', () => {
    const other = selectionContextToken({ text: 'something else' })
    expect(
      isPersistedTwin(user('p', wireOf(`Explain ${ctx}`)), user('l', `Explain ${other}`), false)
    ).toBe(false)
  })
})
