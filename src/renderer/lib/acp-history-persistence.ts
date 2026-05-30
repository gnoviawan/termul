/**
 * Persistence for ACP chat history.
 *
 * Layout (versioned JSON via persistenceApi):
 *   acp/sessions/index      → SessionIndexEntry[]
 *   acp/sessions/<id>       → SessionPayload { metadata, messages }
 *
 * The store is the runtime source of truth; this is a mirror. Payload writes are
 * debounced so streaming doesn't thrash the disk.
 */
import { persistenceApi } from '@/lib/api'
import type { ChatMessage, SessionStatus } from '@/stores/acp-store'

export const SESSION_INDEX_KEY = 'acp/sessions/index'
export function sessionPayloadKey(id: string): string {
  return `acp/sessions/${id}`
}

export interface SessionIndexEntry {
  id: string
  agentId: string
  agentConfigId?: string
  title: string
  cwd: string
  createdAt: number
  lastActivityAt: number
  messageCount: number
  status: SessionStatus
}

export interface SessionPayload {
  metadata: SessionIndexEntry
  messages: ChatMessage[]
}

/** Derive a chat title from the first user message; fallback to the agent id. */
export function deriveTitle(messages: ChatMessage[], agentId: string): string {
  const firstUser = messages.find((m) => m.role === 'user')
  if (firstUser) {
    const text = firstUser.blocks
      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join(' ')
      .trim()
    if (text.length > 0) return text.length > 40 ? `${text.slice(0, 40)}…` : text
  }
  return `Agent ${agentId.slice(0, 8)}`
}

export type RecencyGroup = 'Today' | 'Yesterday' | 'Earlier'

/** Bucket sessions by lastActivityAt relative to `now`. Sorted newest-first within groups. */
export function groupSessionsByRecency(
  entries: SessionIndexEntry[],
  now: number
): { group: RecencyGroup; entries: SessionIndexEntry[] }[] {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000

  const buckets: Record<RecencyGroup, SessionIndexEntry[]> = {
    Today: [],
    Yesterday: [],
    Earlier: []
  }
  for (const e of entries) {
    if (e.lastActivityAt >= todayMs) buckets.Today.push(e)
    else if (e.lastActivityAt >= yesterdayMs) buckets.Yesterday.push(e)
    else buckets.Earlier.push(e)
  }
  const order: RecencyGroup[] = ['Today', 'Yesterday', 'Earlier']
  return order
    .map((group) => ({
      group,
      entries: buckets[group].slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    }))
    .filter((g) => g.entries.length > 0)
}

export async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
  const res = await persistenceApi.read<SessionIndexEntry[]>(SESSION_INDEX_KEY)
  if (res.success && Array.isArray(res.data)) return res.data
  return []
}

export async function saveSessionIndex(entries: SessionIndexEntry[]): Promise<void> {
  await persistenceApi.write(SESSION_INDEX_KEY, entries)
}

export async function loadSessionPayload(id: string): Promise<SessionPayload | null> {
  const res = await persistenceApi.read<SessionPayload>(sessionPayloadKey(id))
  if (res.success && res.data) return res.data
  return null
}

export async function saveSessionPayload(id: string, payload: SessionPayload): Promise<void> {
  // Debounced: coalesces streaming updates so disk isn't thrashed.
  await persistenceApi.writeDebounced(sessionPayloadKey(id), payload)
}

export async function deleteSessionPayload(id: string): Promise<void> {
  await persistenceApi.delete(sessionPayloadKey(id))
}
