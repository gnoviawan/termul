/**
 * Wrap skill instructions and optional user text into a single prompt string.
 */
export function formatPromptWithSkill(skillBody: string, userText: string): string {
  const instructions = skillBody.trim()
  const user = userText.trim()

  if (!instructions) return user
  if (!user) return instructions

  return `${instructions}\n\n---\n\n${user}`
}
