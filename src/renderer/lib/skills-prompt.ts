/**
 * Frame one or more Agent Skills and the user's text into a single prompt
 * string. Each skill is rendered as `## <name>\n<body>` under a single
 * `# Agent Skills` header, then the user text follows after a `---` separator
 * so the agent knows the skills are named skills (never a bare `/skill-name`).
 */
export interface FramedSkill {
  name: string
  body: string
}

export function formatPromptWithSkills(skills: FramedSkill[], userText: string): string {
  const user = userText.trim()
  // Drop skills whose body trims to empty — they contribute no instructions
  // and would produce a bare `## name` with no content. A name is required to
  // frame a skill; a malformed entry without one is skipped.
  const framed = skills
    .map((s) => ({ name: s.name.trim(), body: s.body.trim() }))
    .filter((s) => s.name.length > 0 && s.body.length > 0)

  if (framed.length === 0) return user

  const skillsSection = `# Agent Skills\n\n${framed.map((s) => `## ${s.name}\n${s.body}`).join('\n\n')}`

  if (!user) return skillsSection
  return `${skillsSection}\n\n---\n\n${user}`
}
