import { commandToken, SKILL_TOKEN_END, SKILL_TOKEN_START, skillToken } from '@/lib/skill-tokens'
import { formatPromptWithSkills } from '@/lib/skills-prompt'
import { wireBlocksToDisplay, wireTextToDisplay } from '@/lib/skills-wire-reverse'

const GIT_PATH = '/home/u/.agents/skills/git-worktree/SKILL.md'
const REL_PATH = '/home/u/.agents/skills/release-version/SKILL.md'
const WIN_PATH = 'E:\\open-source\\PecutAPP\\termul\\.agents\\skills\\bmad-build\\SKILL.md'

describe('wireTextToDisplay', () => {
  it('reconstructs a single framed skill with its inline marker', () => {
    const wire = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\n\n---\n\nuse this (git-worktree) now`
    expect(wireTextToDisplay(wire)).toBe(`use this ${skillToken('git-worktree')} now`)
  })

  it('reconstructs multiple skills preserving each marker position and duplicates', () => {
    const wire = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\nrelease-version: ${REL_PATH}\n\n---\n\nfirst (git-worktree) then (git-worktree) and (release-version)`
    expect(wireTextToDisplay(wire)).toBe(
      `first ${skillToken('git-worktree')} then ${skillToken('git-worktree')} and ${skillToken('release-version')}`
    )
  })

  it('reconstructs a token-only send (marker is the whole user text)', () => {
    const wire = `# Agent Skills\n\nbmad-build: ${WIN_PATH}\n\n---\n\n(bmad-build)`
    expect(wireTextToDisplay(wire)).toBe(skillToken('bmad-build'))
  })

  it('handles a Windows path with a drive-letter colon in the header line', () => {
    const wire = `# Agent Skills\n\nbmad-build: ${WIN_PATH}\n\n---\n\n(bmad-build)`
    expect(wireTextToDisplay(wire)).toBe(skillToken('bmad-build'))
  })

  it('reconstructs a command-prefixed turn as a command token + skill tokens', () => {
    const wire = `/compact # Agent Skills\n\ngit-worktree: ${GIT_PATH}\n\n---\n\n(git-worktree) hello`
    expect(wireTextToDisplay(wire)).toBe(
      `${commandToken('compact')} ${skillToken('git-worktree')} hello`
    )
  })

  it('reconstructs chips for a token-free send (skills section only, no separator)', () => {
    const wire = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}`
    expect(wireTextToDisplay(wire)).toBe(skillToken('git-worktree'))
  })

  it('reconstructs every framed chip for a multi-skill token-free send', () => {
    const wire = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\nrelease-version: ${REL_PATH}`
    expect(wireTextToDisplay(wire)).toBe(
      `${skillToken('git-worktree')} ${skillToken('release-version')}`
    )
  })

  it('keeps a separator-only fragment raw (split-streaming prefix)', () => {
    const prefix = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\n\n---\n\n`
    expect(wireTextToDisplay(prefix)).toBe(prefix)
  })

  it('passes through when no marker resolves to a framed name', () => {
    // Split continuation: markers not yet arrived, or prose that merely
    // matches the shape. Either way — verbatim.
    const text = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\n\n---\n\nno markers here`
    expect(wireTextToDisplay(text)).toBe(text)
  })

  it('returns plain text without the header verbatim', () => {
    expect(wireTextToDisplay('hello world')).toBe('hello world')
    expect(wireTextToDisplay('')).toBe('')
  })

  it('returns text that merely mentions the header in prose verbatim', () => {
    const prose = 'The agent framed it as # Agent Skills but there is no separator here'
    expect(wireTextToDisplay(prose)).toBe(prose)
  })

  it('passes through when the header exists but the separator is missing with body lines', () => {
    const malformed = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\n\nextra\n\n---\n\n(git-worktree)`
    expect(wireTextToDisplay(malformed)).toBe(malformed)
  })

  it('passes through when the header section contains a blank line', () => {
    const malformed = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\n\n\n\n---\n\n(git-worktree)`
    // headerAndBody = "git-worktree: path\n" → the '\n\n' check aborts before
    // the separator is even consulted.
    expect(wireTextToDisplay(malformed)).toBe(malformed)
  })

  it('passes through when a header line has an empty path', () => {
    const malformed = `# Agent Skills\n\ngit-worktree:\n\n---\n\n(git-worktree)`
    expect(wireTextToDisplay(malformed)).toBe(malformed)
  })

  it('passes through when a header line has an invalid name', () => {
    const malformed = `# Agent Skills\n\nnot a name: ${GIT_PATH}\n\n---\n\n(git-worktree)`
    expect(wireTextToDisplay(malformed)).toBe(malformed)
  })

  it('keeps an unframed marker literal (typed parenthetical, no header entry)', () => {
    const wire = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\n\n---\n\nsee (footnote) and (git-worktree)`
    expect(wireTextToDisplay(wire)).toBe(`see (footnote) and ${skillToken('git-worktree')}`)
  })

  it('passes through an empty header section (separator with no lines)', () => {
    const malformed = `# Agent Skills\n\n\n\n---\n\n(git-worktree)`
    // afterHeader starts '\n\n', headerAndBody = '\n---\n\n...' → sepIdx 0 →
    // headerLines '' → abort.
    expect(wireTextToDisplay(malformed)).toBe(malformed)
  })

  it('passes through a separator without the header', () => {
    const text = `intro\n\n---\n\n(git-worktree)`
    expect(wireTextToDisplay(text)).toBe(text)
  })

  it('is a no-op on display text that already carries tokens', () => {
    const display = `use this ${skillToken('git-worktree')} now`
    expect(wireTextToDisplay(display)).toBe(display)
  })

  it('passes through a lone command prefix without the skills header', () => {
    const text = '/compact hello'
    expect(wireTextToDisplay(text)).toBe(text)
  })
  it('round-trips the forward direction of formatPromptWithSkills', () => {
    const display = `use this ${skillToken('git-worktree')} and ${skillToken('release-version')}`
    const wire = formatPromptWithSkills(
      [
        { name: 'git-worktree', path: GIT_PATH },
        { name: 'release-version', path: REL_PATH }
      ],
      display
    )
    expect(wireTextToDisplay(wire)).toBe(display)
  })
})

describe('wireBlocksToDisplay', () => {
  it('normalizes text blocks of a user prompt and keeps other blocks untouched', () => {
    const image = { type: 'image', data: 'abc' }
    const blocks = [
      { type: 'text', text: `# Agent Skills\n\nbmad-build: ${WIN_PATH}\n\n---\n\n(bmad-build)` },
      image
    ]
    const out = wireBlocksToDisplay(blocks)
    expect(out[0]).toEqual({ type: 'text', text: skillToken('bmad-build') })
    expect(out[1]).toBe(image)
  })

  it('returns the same array reference when nothing changes', () => {
    const blocks = [{ type: 'text', text: 'hello' }]
    expect(wireBlocksToDisplay(blocks)).toBe(blocks)
  })

  it('keeps a text block with no text field untouched', () => {
    const blocks = [{ type: 'text' }]
    expect(wireBlocksToDisplay(blocks)).toBe(blocks)
  })

  it('emits token sentinels the timeline chip renderer parses', () => {
    const wire = `# Agent Skills\n\ngit-worktree: ${GIT_PATH}\n\n---\n\n(git-worktree)`
    const out = wireBlocksToDisplay([{ type: 'text', text: wire }])
    const text = out[0].text ?? ''
    expect(text).toContain(SKILL_TOKEN_START)
    expect(text).toContain(SKILL_TOKEN_END)
    expect(text).not.toContain('# Agent Skills')
  })
})
