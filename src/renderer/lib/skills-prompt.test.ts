import { describe, expect, it } from 'vitest'
import { formatPromptWithSkill } from '@/lib/skills-prompt'

describe('formatPromptWithSkill', () => {
  it('returns user text when skill body is empty', () => {
    expect(formatPromptWithSkill('', 'hello')).toBe('hello')
  })

  it('returns skill body when user text is empty', () => {
    expect(formatPromptWithSkill('## Do work', '')).toBe('## Do work')
  })

  it('joins skill and user text with a separator', () => {
    expect(formatPromptWithSkill('## Skill', 'hello')).toBe('## Skill\n\n---\n\nhello')
  })

  it('trims leading and trailing whitespace from both parts', () => {
    expect(formatPromptWithSkill('  ## Skill  ', '  hello  ')).toBe('## Skill\n\n---\n\nhello')
  })

  it('returns user text when skill body is whitespace-only', () => {
    expect(formatPromptWithSkill('   ', 'hello')).toBe('hello')
  })

  it('returns skill body when user text is whitespace-only', () => {
    expect(formatPromptWithSkill('## Skill', '   ')).toBe('## Skill')
  })
})
