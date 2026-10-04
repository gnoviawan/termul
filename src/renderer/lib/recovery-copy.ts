/**
 * User-facing failure copy. Names the action, keeps an optional cause, and
 * always ends with a way to recover.
 */
export function unableTo(action: string, detail?: string | null, recovery = 'Try again.'): string {
  const next = recovery.endsWith('.') ? recovery : `${recovery}.`
  const reason = detail?.trim()
  if (!reason) return `Unable to ${action}. ${next}`

  const recoveryStem = next.replace(/\.$/, '').toLowerCase()
  if (reason.toLowerCase().includes(recoveryStem)) return reason

  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`
  return `Unable to ${action}. ${sentence} ${next}`
}
