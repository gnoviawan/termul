import { describe, expect, it } from 'vitest'
import { buildPromptWithLoadedSkills } from '@/hooks/use-agent-skills'
import { skillToken } from '@/lib/skill-tokens'

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
