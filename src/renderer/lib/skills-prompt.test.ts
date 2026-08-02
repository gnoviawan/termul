import { describe, expect, it } from 'vitest'
import { skillToken } from '@/lib/skill-tokens'
import { formatPromptWithSkills } from '@/lib/skills-prompt'

const T = skillToken

describe('formatPromptWithSkills (path-based wire framing)', () => {
  const GIT = { name: 'git-worktree', path: '/home/user/.agents/skills/git-worktree/SKILL.md' }
  const REL = {
    name: 'release-version',
    path: '/home/user/.agents/skills/release-version/SKILL.md'
  }

  it('frames a single skill as `<name>: <path>` under # Agent Skills then the user text with (name) inline', () => {
    expect(formatPromptWithSkills([GIT], `use this ${T('git-worktree')} now`)).toBe(
      `# Agent Skills\n\n${GIT.name}: ${GIT.path}\n\n---\n\nuse this (git-worktree) now`
    )
  })

  it('frames multiple skills, one `<name>: <path>` line each, preserving order', () => {
    expect(
      formatPromptWithSkills(
        [GIT, REL],
        `use this ${T('git-worktree')} and then ${T('release-version')}`
      )
    ).toBe(
      `# Agent Skills\n\n${GIT.name}: ${GIT.path}\n${REL.name}: ${REL.path}\n\n---\n\nuse this (git-worktree) and then (release-version)`
    )
  })

  it('matches the Design Notes wire example verbatim', () => {
    expect(
      formatPromptWithSkills(
        [GIT, REL],
        `use this ${T('git-worktree')} and then ${T('release-version')}`
      )
    ).toBe(
      [
        '# Agent Skills',
        '',
        'git-worktree: /home/user/.agents/skills/git-worktree/SKILL.md',
        'release-version: /home/user/.agents/skills/release-version/SKILL.md',
        '',
        '---',
        '',
        'use this (git-worktree) and then (release-version)'
      ].join('\n')
    )
  })

  it('dedupes the header by name while the inline (name) repeats per token position', () => {
    expect(
      formatPromptWithSkills([GIT], `first ${T('git-worktree')} then ${T('git-worktree')} again`)
    ).toBe(
      `# Agent Skills\n\n${GIT.name}: ${GIT.path}\n\n---\n\nfirst (git-worktree) then (git-worktree) again`
    )
  })

  it('returns only the inline-replaced user text when there are no skills', () => {
    expect(formatPromptWithSkills([], `use this ${T('git-worktree')} now`)).toBe(
      'use this (git-worktree) now'
    )
  })

  it('returns plain user text when there are no skills and no tokens', () => {
    expect(formatPromptWithSkills([], 'just text')).toBe('just text')
  })

  it('returns empty string for empty skills and empty user text', () => {
    expect(formatPromptWithSkills([], '')).toBe('')
  })

  it('returns only the skills section when the user text is empty (token-free)', () => {
    expect(formatPromptWithSkills([GIT], '')).toBe(`# Agent Skills\n\n${GIT.name}: ${GIT.path}`)
  })

  it('keeps the (name) body when the user text is token-only', () => {
    expect(formatPromptWithSkills([GIT], T('git-worktree'))).toBe(
      `# Agent Skills\n\n${GIT.name}: ${GIT.path}\n\n---\n\n(git-worktree)`
    )
  })

  it('trims leading/trailing whitespace from names, paths, and the user text', () => {
    expect(
      formatPromptWithSkills(
        [{ name: '  git-worktree  ', path: '  /p/SKILL.md  ' }],
        `  hello ${T('git-worktree')}  `
      )
    ).toBe(`# Agent Skills\n\ngit-worktree: /p/SKILL.md\n\n---\n\nhello (git-worktree)`)
  })

  it('skips skills with empty paths but still replaces their inline tokens with (name)', () => {
    // A skill surfaced without a path (web parity gap) — the renderer Block If
    // halts before this point, but the framer is defensive: the header omits it
    // while the inline (name) still appears so the user text stays readable.
    expect(formatPromptWithSkills([{ name: 'pathless', path: '' }], `${T('pathless')} hi`)).toBe(
      '(pathless) hi'
    )
  })

  it('skips skills with empty names', () => {
    expect(
      formatPromptWithSkills([{ name: '', path: '/p/SKILL.md' }], `hi ${T('git-worktree')}`)
    ).toBe('hi (git-worktree)')
  })

  it('never emits a bare /skill-name as the skill payload', () => {
    const out = formatPromptWithSkills([GIT], `hello ${T('git-worktree')}`)
    // The skill is cited as `<name>: <path>` and inline `(name)`, never as a
    // bare `/git-worktree` slash command. (The path legitimately contains the
    // name as a segment, so we assert no standalone slash-command token.)
    expect(out).not.toMatch(/(^|\s)\/git-worktree(\s|$)/)
    expect(out).toContain('git-worktree: ')
    expect(out).toContain('(git-worktree)')
  })
})
