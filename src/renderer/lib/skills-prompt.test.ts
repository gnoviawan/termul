import { describe, expect, it } from 'vitest'
import { formatPromptWithSkills } from '@/lib/skills-prompt'

describe('formatPromptWithSkills', () => {
  it('returns user text when no skills are provided', () => {
    expect(formatPromptWithSkills([], 'hello')).toBe('hello')
  })

  it('frames a single skill under a # Agent Skills header followed by user text', () => {
    expect(
      formatPromptWithSkills([{ name: 'git-worktree', body: 'Create a worktree.' }], 'hello')
    ).toBe('# Agent Skills\n\n## git-worktree\nCreate a worktree.\n\n---\n\nhello')
  })

  it('frames multiple skills in order, each as its own ## block', () => {
    expect(
      formatPromptWithSkills(
        [
          { name: 'git-worktree', body: 'Create a worktree.' },
          { name: 'plan', body: 'Plan the work.' }
        ],
        'hello'
      )
    ).toBe(
      '# Agent Skills\n\n## git-worktree\nCreate a worktree.\n\n## plan\nPlan the work.\n\n---\n\nhello'
    )
  })

  it('returns only the skills section when user text is empty', () => {
    expect(formatPromptWithSkills([{ name: 'git-worktree', body: 'Create a worktree.' }], '')).toBe(
      '# Agent Skills\n\n## git-worktree\nCreate a worktree.'
    )
  })

  it('returns only user text when every skill body is empty (nothing to frame)', () => {
    expect(
      formatPromptWithSkills(
        [
          { name: 'empty', body: '' },
          { name: 'whitespace', body: '   ' }
        ],
        'hello'
      )
    ).toBe('hello')
  })

  it('drops skills with empty bodies but keeps skills with content', () => {
    expect(
      formatPromptWithSkills(
        [
          { name: 'empty', body: '' },
          { name: 'git-worktree', body: 'Create a worktree.' }
        ],
        'hello'
      )
    ).toBe('# Agent Skills\n\n## git-worktree\nCreate a worktree.\n\n---\n\nhello')
  })

  it('trims leading and trailing whitespace from skill names, bodies, and user text', () => {
    expect(
      formatPromptWithSkills(
        [{ name: '  git-worktree  ', body: '  Create a worktree.  ' }],
        '  hello  '
      )
    ).toBe('# Agent Skills\n\n## git-worktree\nCreate a worktree.\n\n---\n\nhello')
  })

  it('returns empty string when there are no skills and no user text', () => {
    expect(formatPromptWithSkills([], '')).toBe('')
  })

  it('returns only the skills section when user text is whitespace-only', () => {
    expect(
      formatPromptWithSkills([{ name: 'git-worktree', body: 'Create a worktree.' }], '   ')
    ).toBe('# Agent Skills\n\n## git-worktree\nCreate a worktree.')
  })

  it('never emits a bare /skill-name as the skill payload', () => {
    const out = formatPromptWithSkills(
      [{ name: 'git-worktree', body: 'Create a worktree.' }],
      'hello'
    )
    expect(out).not.toContain('/git-worktree')
    expect(out).toContain('## git-worktree')
  })
})
