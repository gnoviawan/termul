/**
 * Frame one or more Agent Skills and the user's text into a single prompt string.
 * Each skill is cited as `<name>: <path>` under a single `# Agent Skills`
 * header (the agent reads the body from disk via the path — no body is shipped),
 * then the user text follows after a `---` separator with each inline skill
 * token replaced by `(<name>)` so the agent knows where a skill applies in the
 * sentence. Empty skills → only the inline-replaced user text is returned.
 */
import { extractSkillNames, replaceSkillTokensInline, type SkillSegment } from '@/lib/skill-tokens'

export interface FramedSkill {
  name: string
  path: string
}

export function formatPromptWithSkills(skills: FramedSkill[], userText: string): string {
  // Inline-replace tokens (→ `(name)`) even when there are no framed skills, so
  // a value carrying a token with no matching path entry still degrades to
  // `(name)` rather than leaking a private-use sentinel.
  const userInline = replaceSkillTokensInline(userText).trim()

  // Unique-by-name header lines; preserve first-appearance order. A skill
  // without a non-empty path is skipped (the renderer Block If prevents this,
  // but the framer is defensive).
  const seen = new Set<string>()
  const lines: string[] = []
  for (const s of skills) {
    const name = s.name.trim()
    const path = s.path.trim()
    if (name.length === 0 || path.length === 0) continue
    if (seen.has(name)) continue
    seen.add(name)
    lines.push(`${name}: ${path}`)
  }

  if (lines.length === 0) return userInline
  const skillsSection = `# Agent Skills\n\n${lines.join('\n')}`
  if (!userInline) return skillsSection
  return `${skillsSection}\n\n---\n\n${userInline}`
}

export type { SkillSegment }
/**
 * Extract the unique skill names (in first-appearance order) from a value
 * carrying skill tokens. Re-exported from the token model for callers that
 * build the `{name; path}` list at send time.
 */
export { extractSkillNames }
