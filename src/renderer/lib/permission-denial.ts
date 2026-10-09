/**
 * Copy shared by the permission prompt, the denied-by-disconnect notice line and
 * its shell announcement. Pure: no stores, no DOM.
 */

/** Title text for the requesting tool call, best-effort from the update fields. */
export function permissionToolTitle(toolCall: unknown): string {
  if (toolCall && typeof toolCall === 'object') {
    const t = toolCall as { title?: string; toolCallId?: string }
    return t.title ?? t.toolCallId ?? 'this action'
  }
  return 'this action'
}

/**
 * What the user reads (and the shell region speaks) after the server denied a
 * pending permission because this device disconnected. One copy for both.
 */
export function permissionDeniedMessage(tool: string): string {
  return `Permission for ${tool} was denied because this device disconnected. Ask the agent to retry.`
}
