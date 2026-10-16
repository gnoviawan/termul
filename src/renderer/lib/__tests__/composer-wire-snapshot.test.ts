import { describe, expect, it } from 'vitest'
import { buildPromptWithLoadedSkills } from '@/hooks/use-agent-skills'
import {
  commandToken,
  extractCommandName,
  insertCommandToken,
  replaceCommandTokensInline,
  skillToken,
  stripCommandToken
} from '@/lib/skill-tokens'

/**
 * Wire-format regression fence for the chat-composer modular redesign.
 *
 * These snapshots capture `buildPromptWithLoadedSkills` output for the
 * display/wire content shapes the composer emits (plain text, one skill, two
 * skills, skill+command, skill mid-text, resumed draft). They were authored
 * alongside the Tiptap migration and lock the byte-exact wire payload the
 * pre-refactor transparent-`<textarea>` surface produced: the display string
 * carries sentinel tokens, the wire text frames skills by path under
 * `# Agent Skills` and replaces each token with `(name)` inline. Any change to
 * the editor doc → display-string serializer (`doc-to-prompt.ts`) or to the
 * composer's wire builder that shifts this output will fail here.
 */

const T = skillToken

const SKILL_GIT = {
  name: 'git-worktree',
  path: '/home/u/.agents/skills/git-worktree/SKILL.md'
}
const SKILL_RELEASE = {
  name: 'release-version',
  path: '/home/u/.agents/skills/release-version/SKILL.md'
}

describe('composer wire snapshots', () => {
  it('passes plain text through (no skills, no tokens)', () => {
    expect(buildPromptWithLoadedSkills([], 'hello world')).toMatchInlineSnapshot(`"hello world"`)
  })

  it('frames one skill by path under # Agent Skills and inlines (name)', () => {
    const display = `use this ${T('git-worktree')} and then`
    expect(buildPromptWithLoadedSkills([SKILL_GIT], display)).toMatchInlineSnapshot(
      `
        "# Agent Skills

        git-worktree: /home/u/.agents/skills/git-worktree/SKILL.md

        ---

        use this (git-worktree) and then"
      `
    )
  })

  it('frames two unique skills (header dedupes by name, inline repeats per token)', () => {
    const display = `${T('git-worktree')} then ${T('release-version')}`
    expect(buildPromptWithLoadedSkills([SKILL_GIT, SKILL_RELEASE], display)).toMatchInlineSnapshot(
      `
        "# Agent Skills

        git-worktree: /home/u/.agents/skills/git-worktree/SKILL.md
        release-version: /home/u/.agents/skills/release-version/SKILL.md

        ---

        (git-worktree) then (release-version)"
      `
    )
  })

  it('preserves inline duplicates (same skill at multiple positions, header lists once)', () => {
    const display = `first ${T('git-worktree')} again ${T('git-worktree')}`
    expect(buildPromptWithLoadedSkills([SKILL_GIT], display)).toMatchInlineSnapshot(
      `
        "# Agent Skills

        git-worktree: /home/u/.agents/skills/git-worktree/SKILL.md

        ---

        first (git-worktree) again (git-worktree)"
      `
    )
  })

  it('inlines (name) and strips tokens even when the skill has no path entry (degrades gracefully)', () => {
    const display = `use this ${T('ghost')} hi`
    // No path → the framer skips the header line but still inline-replaces the
    // token so a private-use sentinel never leaks to the agent.
    expect(buildPromptWithLoadedSkills([], display)).toMatchInlineSnapshot(`"use this (ghost) hi"`)
  })

  it('resumes a draft that carries sentinel tokens (re-hydration path)', () => {
    // The persisted draft carries the raw token string; the composer parses it
    // into pill nodes on hydrate. The wire output for the resumed content must
    // equal the original send's wire output (byte-identical round-trip).
    const resumedDraft = `use this ${T('git-worktree')} then`
    expect(buildPromptWithLoadedSkills([SKILL_GIT], resumedDraft)).toMatchInlineSnapshot(
      `
        "# Agent Skills

        git-worktree: /home/u/.agents/skills/git-worktree/SKILL.md

        ---

        use this (git-worktree) then"
      `
    )
  })

  it('frames a skill that sits in the user sentence', () => {
    const display = `${T('git-worktree')} do the thing`
    expect(buildPromptWithLoadedSkills([SKILL_GIT], display)).toMatchInlineSnapshot(
      `
        "# Agent Skills

        git-worktree: /home/u/.agents/skills/git-worktree/SKILL.md

        ---

        (git-worktree) do the thing"
      `
    )
  })

  it('handles a mid-text skill (token not at sentence start)', () => {
    const display = `prefix text ${T('release-version')} suffix`
    expect(buildPromptWithLoadedSkills([SKILL_RELEASE], display)).toMatchInlineSnapshot(
      `
        "# Agent Skills

        release-version: /home/u/.agents/skills/release-version/SKILL.md

        ---

        prefix text (release-version) suffix"
      `
    )
  })

  it('keeps a skill marker in the sentence and the path in the header', () => {
    const display = `buatkan design baru menggunakan skill ini ${T('design')}`
    expect(buildPromptWithLoadedSkills([{ name: 'design', path: '/path/SKILL.md' }], display)).toBe(
      [
        '# Agent Skills',
        '',
        'design: /path/SKILL.md',
        '',
        '---',
        '',
        'buatkan design baru menggunakan skill ini (design)'
      ].join('\n')
    )
  })
})

/**
 * Command-pill wire snapshots. A command token stays in the sentence. The
 * wire replaces it with `/<name>` at that position. It is not moved to the
 * front of the prompt.
 */
describe('composer wire snapshots — command pill', () => {
  const CT = (name: string): string => commandToken(name)

  it('extractCommandName reads the command name from the token', () => {
    expect(extractCommandName(CT('compact'))).toBe('compact')
    expect(extractCommandName(`hello ${CT('clear')} world`)).toBe('clear')
    expect(extractCommandName('no command here')).toBeNull()
    // Malformed (no close) — treated as absent.
    expect(extractCommandName('\uE004compact without close')).toBeNull()
  })

  it('stripCommandToken removes the token + trailing space (de-commanded wire text)', () => {
    expect(stripCommandToken(`${CT('compact')} `)).toBe('')
    expect(stripCommandToken(`${CT('compact')} hello`)).toBe('hello')
    expect(stripCommandToken(`prefix ${CT('compact')} suffix`)).toBe('prefix suffix')
    // No token → unchanged.
    expect(stripCommandToken('no command')).toBe('no command')
  })

  it('insertCommandToken rejects a second command (single-command invariant)', () => {
    const first = insertCommandToken('/', 1, 'compact', 1)
    expect(first.inserted).toBe(true)
    if (first.inserted) {
      expect(first.value).toBe(`${CT('compact')} `)
    }
    // A second command token is rejected.
    const second = insertCommandToken(first.inserted ? first.value : '', 5, 'clear', 0)
    expect(second.inserted).toBe(false)
    if (!second.inserted) {
      expect(second.reason).toBe('existing_command')
    }
  })

  it('insertCommandToken clamps when deleteBefore > caret (start floors at 0, token prepended)', () => {
    // When deleteBefore > caret, `start` floors at 0 and `end` = caret. With
    // caret=0, end=start=0 → nothing deleted, token prepended to full value.
    const result = insertCommandToken('hello', 0, 'compact', 5)
    expect(result.inserted).toBe(true)
    if (result.inserted) {
      expect(result.value).toBe(`${CT('compact')} hello`)
      // Caret lands after the token + trailing space.
      expect(result.caret).toBe(CT('compact').length + 1)
    }

    // With caret > 0, start floors at 0, end = caret → first `caret` chars
    // deleted (the clamp caps deleteBefore at caret), token prepended.
    const result2 = insertCommandToken('hello', 2, 'clear', 10)
    expect(result2.inserted).toBe(true)
    if (result2.inserted) {
      // The first 2 chars ("he") are deleted; the token is prepended to "llo".
      expect(result2.value).toBe(`${CT('clear')} llo`)
      expect(result2.caret).toBe(CT('clear').length + 1)
    }
  })

  it('keeps a leading command where it was typed', () => {
    const value = `${CT('compact')} hello`
    expect(replaceCommandTokensInline(value).trim()).toBe('/compact hello')
  })

  it('keeps a mid-sentence command in the sentence, including inside skill framing', () => {
    const value = `hello ${CT('compact')} ${T('git-worktree')} world`
    const wire = buildPromptWithLoadedSkills([SKILL_GIT], replaceCommandTokensInline(value))
    expect(wire).toBe(
      [
        '# Agent Skills',
        '',
        'git-worktree: /home/u/.agents/skills/git-worktree/SKILL.md',
        '',
        '---',
        '',
        'hello /compact (git-worktree) world'
      ].join('\n')
    )
  })

  it('keeps a command-only token as /<name>', () => {
    expect(replaceCommandTokensInline(`${CT('compact')} `).trim()).toBe('/compact')
  })

  it('display keeps the command token in place', () => {
    const value = `hello ${CT('compact')} world`
    expect(value).toBe(`hello ${commandToken('compact')} world`)
    expect(replaceCommandTokensInline(value)).toBe('hello /compact world')
  })
})
