import { describe, expect, it } from 'vitest'
import { buildPromptWithLoadedSkills } from '@/hooks/use-agent-skills'
import {
  commandToken,
  extractCommandName,
  insertCommandToken,
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

  it('handles a skill+command scenario (display token text + active command prefix applied by the host)', () => {
    // The host prepends `/${activeCommand} ` to both wire and display after
    // buildPromptWithLoadedSkills returns; this snapshot locks the wire body
    // the composer produces for a skill-carrying message before that prefix.
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
})

/**
 * Command-pill wire snapshots (CAP — Inline command pill). The inline
 * `\uE004<name>\uE005` token replaces the removed `activeCommand` state. At
 * send, `buildPromptParts` calls `extractCommandName(value)` →
 * `wireWithCommand = \`/${name} ${wireText}\`` (byte-identical to the old
 * `activeCommand` path). The token is stripped from `wireText` (the skill wire
 * framer receives the de-commanded text).
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

  it('byte-identical wire: command pill + text → `/<name> <text>` (matches old activeCommand path)', () => {
    // The value carries the command token + user text. buildPromptParts strips
    // the token, builds the skill wire (none here), then prefixes `/<name> `.
    const value = `${CT('compact')} hello`
    const commandName = extractCommandName(value)
    const valueDecommanded = stripCommandToken(value)
    const wireText = buildPromptWithLoadedSkills([], valueDecommanded)
    const wireWithCommand = commandName ? `/${commandName} ${wireText}` : wireText
    expect(wireWithCommand).toBe('/compact hello')
  })

  it('byte-identical wire: command pill + skill pill (command prefix + skill framing)', () => {
    const value = `${CT('compact')} ${T('git-worktree')} do the thing`
    const commandName = extractCommandName(value)
    const valueDecommanded = stripCommandToken(value)
    const wireText = buildPromptWithLoadedSkills([SKILL_GIT], valueDecommanded)
    const wireWithCommand = commandName ? `/${commandName} ${wireText}` : wireText
    expect(wireWithCommand).toMatchInlineSnapshot(
      `
        "/compact # Agent Skills

        git-worktree: /home/u/.agents/skills/git-worktree/SKILL.md

        ---

        (git-worktree) do the thing"
      `
    )
  })

  it('byte-identical wire: command pill alone (no user text) → `/<name>`', () => {
    const value = `${CT('compact')} `
    const commandName = extractCommandName(value)
    const valueDecommanded = stripCommandToken(value)
    const wireText = buildPromptWithLoadedSkills([], valueDecommanded)
    const wireWithCommand = commandName ? `/${commandName} ${wireText}`.trim() : wireText
    expect(wireWithCommand).toBe('/compact')
  })
})
