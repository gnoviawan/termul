import { useState } from 'react'

import { toast } from 'sonner'

import { useAcpStore } from '@/stores/acp-store'

/**
 * Update Application follow-through (ADR-0002 / Q5): after a per-agent update,
 * the live agent process still runs the old binary until its next spawn. When
 * the session's owning config has an applied-but-not-respawned version, this
 * banner says so in agent language: THIS chat keeps the old version, the user's
 * NEXT chat picks up the new one — and a one-click "Open new chat" action
 * starts that next chat immediately (the update's warm-state teardown already
 * guarantees the new chat spawns the applied version). The running chat itself
 * is never killed (live PTY sessions are never killed as cleanup, per
 * AGENTS.md) — the user keeps it open and closes it whenever they like.
 */
export function PendingRestartBanner({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const [opening, setOpening] = useState(false)
  const agentId = useAcpStore((s) => s.sessions[sessionId]?.agentId ?? null)
  // The owning config id: prefer the persisted session index (it survives the
  // reuse-map detachment the update's follow-through performs on live agents);
  // fall back to the live reuse map.
  const configId = useAcpStore((s) => {
    const indexEntry = s.sessionIndex.find((e) => e.id === sessionId)
    if (indexEntry?.agentConfigId) return indexEntry.agentConfigId
    if (!agentId) return null
    const reuseKey = Object.keys(s.configToLiveAgent).find(
      (k) => s.configToLiveAgent[k] === agentId
    )
    return reuseKey ? (reuseKey.split('\0')[0] ?? null) : null
  })
  const pending = useAcpStore((s) =>
    configId ? (s.pendingRestartVersions[configId] ?? null) : null
  )
  const cwd = useAcpStore((s) => s.sessions[sessionId]?.cwd ?? null)
  const projectId = useAcpStore((s) => s.sessions[sessionId]?.projectId ?? null)
  const startChat = useAcpStore((s) => s.startChat)

  if (!pending || !configId || !cwd) return null

  const openNewChat = (): void => {
    setOpening(true)
    void startChat(configId, cwd, undefined, projectId ?? undefined)
      .catch((err) =>
        toast.error(
          `Could not start a new chat: ${err instanceof Error ? err.message : String(err)}`
        )
      )
      .finally(() => setOpening(false))
  }

  return (
    <div
      role="status"
      data-testid="pending-restart-banner"
      className="flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-600 dark:text-sky-400"
    >
      <span className="min-w-0 flex-1">
        This chat still runs the old version — new version {pending} applies to your next chat with
        this agent.
      </span>
      <button
        type="button"
        onClick={openNewChat}
        disabled={opening}
        data-testid="pending-restart-new-chat"
        className="inline-flex shrink-0 items-center rounded-md border border-sky-500/40 px-2 py-0.5 text-2xs font-medium transition-colors hover:bg-sky-500/15 disabled:cursor-progress disabled:opacity-70"
      >
        {opening ? 'Opening…' : 'Open new chat'}
      </button>
    </div>
  )
}
