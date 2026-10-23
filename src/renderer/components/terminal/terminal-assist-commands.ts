/** True when the text contains a newline or any terminal control character. */
function hasTerminalControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Extract fenced code blocks (```sh / ```bash / bare ```) from a response.
 *
 * Only single-line commands without terminal control characters are offered
 * for insertion (#689 review): `terminalApi.write` forwards text straight to
 * the PTY, so a newline or control byte would execute the command — violating
 * the "inserted for review, never run" contract. Multi-line or tainted
 * blocks stay visible as markdown but get no Insert button.
 */
export function extractSuggestedCommands(markdown: string): string[] {
  const commands: string[] = []
  const fenced = /```(?:sh|shell|bash)?\s*\n([\s\S]*?)```/g
  for (const match of markdown.matchAll(fenced)) {
    const body = (match[1] ?? '').trim()
    if (body.length === 0) continue
    if (hasTerminalControlCharacter(body)) continue
    commands.push(body)
  }
  return commands
}
