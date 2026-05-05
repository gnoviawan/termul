export function deterministicToken(index: number): string {
  const value = (index * 1664525 + 1013904223) >>> 0
  return value.toString(36).padStart(8, '0').slice(0, 8)
}

export function generateHeavyOutput(lineCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    const prefix = `\u001b[32m[${String(i).padStart(4, '0')}]\u001b[0m `
    const content = `Build step ${i}: ${'='.repeat(60)} ${deterministicToken(i)}`
    lines.push(prefix + content)
  }
  return lines.join('\r\n')
}

export function generateWideLines(lineCount: number, width: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    lines.push(`Line ${i}: ${'x'.repeat(width)}`)
  }
  return lines.join('\r\n')
}
