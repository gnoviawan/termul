import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { SessionInfo } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { CLAUDE_AGENT_CONFIG_ID } from '@/stores/claude-account-switch'

export type ImportChatsPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; agentId: string; sessions: SessionInfo[] }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

interface UseImportChatsOptions {
  open: boolean
  cwd: string
  projectId: string
  /** Called once an import run finished with every chat imported. */
  onDone: () => void
}

export interface ImportChats {
  configs: { id: string; name: string }[]
  configId: string | null
  setConfigId: (id: string) => void
  phase: ImportChatsPhase
  selected: ReadonlySet<string>
  toggle: (sessionId: string) => void
  selectAll: () => void
  clearSelection: () => void
  importing: boolean
  progress: number
  failure: string | null
  importSelected: () => Promise<void>
  retry: () => void
}

/**
 * State of the "Import chats" dialog: lists the sessions the chosen agent
 * keeps for the working copy, tracks the selection and drives the import.
 * Candidates are read when the dialog opens and again after each run, so a
 * chat that was imported leaves the list.
 */
export function useImportChats({
  open,
  cwd,
  projectId,
  onDone
}: UseImportChatsOptions): ImportChats {
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const selectedConfigId = useAcpStore((s) => s.selectedAgentConfigId)
  const listImportableSessions = useAcpStore((s) => s.listImportableSessions)
  const importAgentSessions = useAcpStore((s) => s.importAgentSessions)

  const configs = useMemo(
    () => agentConfigs.map((config) => ({ id: config.id, name: config.name })),
    [agentConfigs]
  )
  const [pickedConfigId, setConfigId] = useState<string | null>(null)
  const configId = useMemo(() => {
    const has = (id: string | null): id is string => id !== null && configs.some((c) => c.id === id)
    if (has(pickedConfigId)) return pickedConfigId
    if (has(CLAUDE_AGENT_CONFIG_ID)) return CLAUDE_AGENT_CONFIG_ID
    if (has(selectedConfigId)) return selectedConfigId
    return configs[0]?.id ?? null
  }, [pickedConfigId, selectedConfigId, configs])

  const [phase, setPhase] = useState<ImportChatsPhase>({ kind: 'loading' })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [failure, setFailure] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  // A listing started for an older config, cwd or open state must not land.
  const listingRef = useRef(0)

  const reload = useCallback(
    async (isFirst: boolean): Promise<void> => {
      if (!configId) return
      const listing = ++listingRef.current
      if (isFirst) setPhase({ kind: 'loading' })
      try {
        const result = await listImportableSessions(configId, cwd, projectId)
        if (listing !== listingRef.current) return
        if (result.status === 'ready') {
          setPhase({ kind: 'ready', agentId: result.agentId, sessions: result.sessions })
          setSelected(
            (prev) =>
              new Set(result.sessions.filter((s) => prev.has(s.sessionId)).map((s) => s.sessionId))
          )
        } else {
          setPhase({ kind: result.status })
        }
      } catch (error) {
        if (listing !== listingRef.current) return
        void logFrontendError({
          level: 'warn',
          source: 'ImportChatsDialog.list',
          message: `Listing agent sessions failed: ${error instanceof Error ? error.message : String(error)}`
        })
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    },
    [configId, cwd, projectId, listImportableSessions]
  )

  // `reloadTick` re-runs the listing for the retry button.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is the retry trigger
  useEffect(() => {
    if (!open) {
      listingRef.current += 1
      return
    }
    setFailure(null)
    void reload(true)
  }, [open, reload, reloadTick])

  const toggle = useCallback((sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    if (phase.kind === 'ready') setSelected(new Set(phase.sessions.map((s) => s.sessionId)))
  }, [phase])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  const importSelected = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'ready' || importing) return
    const chosen = phase.sessions.filter((s) => selected.has(s.sessionId))
    if (chosen.length === 0) return
    setImporting(true)
    setProgress(0)
    setFailure(null)
    const listing = listingRef.current
    try {
      const outcomes = await importAgentSessions({
        agentId: phase.agentId,
        cwd,
        projectId,
        sessions: chosen,
        onProgress: setProgress
      })
      const imported = outcomes.filter((o) => o.status === 'imported').length
      const failed = outcomes.filter((o) => o.status === 'failed')
      if (imported > 0)
        toast.success(imported === 1 ? 'Imported 1 chat' : `Imported ${imported} chats`)
      // The user moved on (another working copy or agent) while this ran: a
      // refresh now would replace the newer listing with the old one's.
      if (listing !== listingRef.current) return
      if (failed.length === 0) {
        onDone()
        return
      }
      setFailure(
        `${failed.length === 1 ? '1 chat' : `${failed.length} chats`} could not be imported. ${failed[0]?.message ?? ''}`.trim()
      )
      await reload(false)
    } finally {
      setImporting(false)
    }
  }, [phase, importing, selected, importAgentSessions, cwd, projectId, onDone, reload])

  return {
    configs,
    configId,
    setConfigId,
    phase,
    selected,
    toggle,
    selectAll,
    clearSelection,
    importing,
    progress,
    failure,
    importSelected,
    retry: () => setReloadTick((tick) => tick + 1)
  }
}
