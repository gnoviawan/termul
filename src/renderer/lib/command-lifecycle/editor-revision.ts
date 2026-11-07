const terminalRevisions = new Map<string, number>()

export function readEditorRevision(terminalId: string): number {
  return terminalRevisions.get(terminalId) ?? 0
}

export function bumpEditorRevision(terminalId: string): number {
  const revision = readEditorRevision(terminalId) + 1
  terminalRevisions.set(terminalId, revision)
  return revision
}

export function clearEditorRevision(terminalId: string): void {
  terminalRevisions.delete(terminalId)
}
