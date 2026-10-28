export interface CompletionOutputRow {
  text: string
  from: number
  to: number
}

export function parseCompletionOutput(
  draft: string,
  cursor: number,
  output: string
): CompletionOutputRow[] {
  const { from, to } = lastWordRange(draft, cursor)
  const seen = new Set<string>()
  const rows: CompletionOutputRow[] = []
  for (const raw of output.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line) continue
    const text = decodeHexLine(line)
    if (text === null || containsDisallowedControls(text) || seen.has(text)) continue
    seen.add(text)
    rows.push({ text, from, to })
  }
  return rows
}

function lastWordRange(draft: string, cursor: number): { from: number; to: number } {
  const point = Math.max(0, Math.min(cursor, draft.length))
  let from = point
  while (from > 0 && !/\s/.test(draft[from - 1] ?? '')) from -= 1
  return { from, to: point }
}

function containsDisallowedControls(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x09 || code === 0x0a) continue
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true
  }
  return false
}

function decodeHexLine(line: string): string | null {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(line)) return null
  const bytes = new Uint8Array(line.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(line.slice(i * 2, i * 2 + 2), 16)
  }
  return new TextDecoder('utf-8').decode(bytes)
}
