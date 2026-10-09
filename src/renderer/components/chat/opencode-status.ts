import type { OpenCodeSessionNotice } from '@/stores/acp-store/types'

/** One live line for the active turn. Retry wins over compaction. */
export function opencodeStatusLine(notice: OpenCodeSessionNotice | undefined): string | null {
  if (!notice) return null
  if (notice.retryAttempt != null) return `Retrying, attempt ${notice.retryAttempt}`
  if (notice.compaction === 'started') return 'Compacting context'
  if (notice.compaction === 'failed') return 'Compaction failed'
  return null
}
