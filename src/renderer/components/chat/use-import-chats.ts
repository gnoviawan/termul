import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { SessionInfo } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import type { ImportSessionOutcome } from '@/stores/acp-store/types'
import { CLAUDE_AGENT_CONFIG_ID } from '@/stores/claude-account-switch'

export type ImportChatsPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; agentId: string; sessions: SessionInfo[] }
  | { kind: 'unsupported' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

/** Counts of the last import run that left chats behind (failed or stopped). */
export interface ImportRunSummary {
  imported: number
  failed: number
  skipped: number
}

/**
 * The sentence a failed import shows. The host's message carries internal
 * codes (`ACP_IMPORT_INCOMPLETE: …`) that stay in the log, never in the UI.
 */
export function importFailureText(message: string | undefined): string {
  const raw = message ?? ''
  if (raw.includes('ACP_IMPORT_INCOMPLETE')) return "Part of this chat's history could not be read."
  if (/timed out|timeout|no answer within/i.test(raw)) return 'The agent took too long to respond.'
  return 'This chat could not be imported.'
}

/** "2 imported, 1 failed, 3 skipped": the imported count always, the rest when non-zero. */
export function formatImportSummary({ imported, failed, skipped }: ImportRunSummary): string {
  const parts = [`${imported} imported`]
  if (failed > 0) parts.push(`${failed} failed`)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  return parts.join(', ')
}

interface UseImportChatsOptions {
  open: boolean
  cwd: string
  projectId: string
  /** Called once an import run finished with every chosen chat imported. */
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
  /** A stop was asked for: the chat in flight finishes, no other starts. */
  stopping: boolean
  requestStop: () => void
  progress: number
  /** Set after a run that failed or was stopped; cleared by the next run. */
  summary: ImportRunSummary | null
  /** Chats of the run in progress; empty when idle. */
  runIds: readonly string[]
  /** How each chat of the run in progress ended so far. */
  rowStatus: ReadonlyMap<string, 'done' | 'failed'>
  /** The chat being imported right now. */
  inFlightId: string | null
  /** User-facing reason per chat that failed in the last run. */
  rowErrors: ReadonlyMap<string, string>
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
  const [stopping, setStopping] = useState(false)
  const stopRef = useRef(false)
  const [progress, setProgress] = useState(0)
  const [summary, setSummary] = useState<ImportRunSummary | null>(null)
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(new Map())
  // The chats of the run in progress, in import order, and how each ended.
  const [runIds, setRunIds] = useState<readonly string[]>([])
  const [rowStatus, setRowStatus] = useState<ReadonlyMap<string, 'done' | 'failed'>>(new Map())
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
    setSummary(null)
    setRowErrors(new Map())
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

  const requestStop = useCallback(() => {
    stopRef.current = true
    setStopping(true)
  }, [])

  const importSelected = useCallback(async (): Promise<void> => {
    if (phase.kind !== 'ready' || importing) return
    const chosen = phase.sessions.filter((s) => selected.has(s.sessionId))
    if (chosen.length === 0) return
    setImporting(true)
    stopRef.current = false
    setStopping(false)
    setProgress(0)
    setSummary(null)
    setRowErrors(new Map())
    setRunIds(chosen.map((s) => s.sessionId))
    setRowStatus(new Map())
    const listing = listingRef.current
    const finished = new Map<string, ImportSessionOutcome>()
    let thrown = false
    try {
      const outcomes = await importAgentSessions({
        agentId: phase.agentId,
        cwd,
        projectId,
        sessions: chosen,
        onProgress: (done, outcome) => {
          finished.set(outcome.sessionId, outcome)
          setProgress(done)
          setRowStatus((prev) =>
            new Map(prev).set(outcome.sessionId, outcome.status === 'failed' ? 'failed' : 'done')
          )
        },
        shouldStop: () => stopRef.current
      })
      for (const outcome of outcomes) finished.set(outcome.sessionId, outcome)
    } catch (error) {
      // The run itself failed, not one chat: the raw error goes to the log and
      // every chat without an outcome counts as failed.
      thrown = true
      void logFrontendError({
        level: 'warn',
        source: 'ImportChatsDialog.import',
        message: `Import run failed: ${error instanceof Error ? error.message : String(error)}`
      })
    }
    try {
      const outcomes = [...finished.values()]
      const imported = outcomes.filter((o) => o.status === 'imported').length
      const failed = outcomes.filter((o) => o.status === 'failed')
      const unfinished = chosen.filter((s) => !finished.has(s.sessionId))
      if (imported > 0)
        toast.success(imported === 1 ? 'Imported 1 chat' : `Imported ${imported} chats`)
      for (const outcome of failed) {
        // The raw host message (with its internal code) goes to the log only.
        void logFrontendError({
          level: 'warn',
          source: 'ImportChatsDialog.import',
          message: `Importing agent session ${outcome.sessionId} failed: ${outcome.message ?? 'no message'}`
        })
      }
      // The user moved on (another working copy or agent) while this ran: a
      // refresh now would replace the newer listing with the old one's.
      if (listing !== listingRef.current) return
      if (failed.length === 0 && unfinished.length === 0) {
        onDone()
        return
      }
      const errors = new Map(failed.map((o) => [o.sessionId, importFailureText(o.message)]))
      if (thrown) for (const s of unfinished) errors.set(s.sessionId, importFailureText(undefined))
      setSummary({
        imported,
        failed: errors.size,
        skipped: thrown ? 0 : unfinished.length
      })
      setRowErrors(errors)
      // Chats that came in leave the list now; the refresh confirms it.
      setPhase((prev) =>
        prev.kind === 'ready'
          ? {
              ...prev,
              sessions: prev.sessions.filter((s) => {
                const outcome = finished.get(s.sessionId)
                return !outcome || outcome.status === 'failed'
              })
            }
          : prev
      )
      await reload(false)
    } finally {
      setImporting(false)
      setStopping(false)
      setRunIds([])
      setRowStatus(new Map())
      stopRef.current = false
    }
  }, [phase, importing, selected, importAgentSessions, cwd, projectId, onDone, reload])

  const inFlightId = importing ? (runIds[progress] ?? null) : null

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
    stopping,
    requestStop,
    progress,
    summary,
    rowErrors,
    runIds,
    rowStatus,
    inFlightId,
    importSelected,
    retry: () => setReloadTick((tick) => tick + 1)
  }
}
