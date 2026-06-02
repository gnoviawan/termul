import type { DetectedShells, ShellInfo } from '@shared/types/ipc.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { ArrowUp, Loader2, Plus, Terminal as TerminalIcon } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { launchAgentInPane } from '@/lib/agent-launch'
import { BUILT_IN_AGENTS, type TerminalAgentDefinition } from '@/lib/agents/agent-registry'
import { loadAllAgents, upsertCustomAgent } from '@/lib/agents/custom-agents'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import { persistenceApi, shellApi } from '@/lib/api'
import { spawnTerminalInPane } from '@/lib/terminal-spawn'
import { cn } from '@/lib/utils'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useDefaultShell, useMaxTerminalsPerProject } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CustomAgentDialog } from './CustomAgentDialog'

/**
 * ADR-004.5: The "blank tab" agent launch surface.
 *
 * Chat-style input bar: agent selector | textarea | launch button.
 * Grid layout ensures clean alignment without overlapping.
 */

interface AgentLauncherProps {
  paneId: string
  agents?: readonly TerminalAgentDefinition[]
  className?: string
}

const AGENT_SELECT_NEW = '__new__'

/** Survives overlay unmount (Ctrl+T) so the selector does not flash the default agent. */
let cachedLastSelectedAgentId: string | null = null

export function AgentLauncher({
  paneId,
  agents: agentsProp,
  className
}: AgentLauncherProps): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [loadedAgents, setLoadedAgents] =
    useState<readonly TerminalAgentDefinition[]>(BUILT_IN_AGENTS)
  const agents = agentsProp ?? loadedAgents
  const [selectedAgentId, setSelectedAgentId] = useState(
    () => cachedLastSelectedAgentId ?? agents[0]?.id ?? ''
  )
  const [isLaunching, setIsLaunching] = useState(false)
  const [isSpawningTerminal, setIsSpawningTerminal] = useState(false)
  const [shells, setShells] = useState<DetectedShells | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  const persistSelectedAgent = useCallback((agentId: string) => {
    if (!agentId || agentId === AGENT_SELECT_NEW) return
    cachedLastSelectedAgentId = agentId
    void persistenceApi.write(PersistenceKeys.lastSelectedAgent, { agentId })
  }, [])

  useEffect(() => {
    if (agentsProp) return
    let cancelled = false
    void (async () => {
      try {
        const [all, persisted] = await Promise.all([
          loadAllAgents(),
          persistenceApi.read<{ agentId: string }>(PersistenceKeys.lastSelectedAgent)
        ])
        if (cancelled) return
        const pool = all.length > 0 ? all : [...BUILT_IN_AGENTS]
        if (all.length > 0) setLoadedAgents(all)
        const savedId = persisted.success ? persisted.data?.agentId : undefined
        const nextId = savedId && pool.some((a) => a.id === savedId) ? savedId : (pool[0]?.id ?? '')
        if (nextId) {
          cachedLastSelectedAgentId = nextId
          setSelectedAgentId(nextId)
        }
      } catch {
        // Keep built-in default when persistence or agent load fails.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentsProp])

  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const maxTerminals = useMaxTerminalsPerProject()
  const appDefaultShell = useDefaultShell()

  useEffect(() => {
    let cancelled = false
    const fetchShells = async (): Promise<void> => {
      try {
        const result = await shellApi.getAvailableShells()
        if (!cancelled && result.success) {
          setShells(result.data)
        }
      } catch {
        if (!cancelled) setShells(null)
      }
    }
    void fetchShells()
    return () => {
      cancelled = true
    }
  }, [])

  const projectDefaultShell = useProjectStore(
    (s) => s.projects.find((p) => p.id === activeProjectId)?.defaultShell
  )

  const sortedShells = useMemo(() => {
    const preferred = projectDefaultShell || appDefaultShell
    return shells?.available?.slice().sort((a, b) => {
      if (preferred) {
        if (a.name === preferred) return -1
        if (b.name === preferred) return 1
      }
      return a.displayName.localeCompare(b.displayName)
    })
  }, [appDefaultShell, projectDefaultShell, shells])

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId]
  )

  const launch = useCallback(
    async (agent: TerminalAgentDefinition | undefined) => {
      if (!agent) return
      if (!activeProjectId) {
        toast.error('No active project')
        return
      }
      if (isLaunching) return

      setIsLaunching(true)
      try {
        const project = useProjectStore.getState().projects.find((p) => p.id === activeProjectId)
        const cwd = getDefaultCwdForProject(activeProjectId)
        const result = await launchAgentInPane(paneId, activeProjectId, cwd, agent, prompt, {
          envVars: project?.envVars,
          maxTerminalsPerProject: maxTerminals
        })
        if (!result.success) {
          toast.error(result.error || 'Failed to launch agent')
        } else {
          useWorkspaceStore.getState().hideAgentLauncher()
        }
      } finally {
        setIsLaunching(false)
      }
    },
    [activeProjectId, isLaunching, maxTerminals, paneId, prompt]
  )

  const handleSubmit = useCallback(() => {
    void launch(selectedAgent)
  }, [launch, selectedAgent])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void launch(selectedAgent)
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        void launch(selectedAgent)
      }
      if (e.key === 'Escape') {
        useWorkspaceStore.getState().hideAgentLauncher()
      }
    },
    [launch, selectedAgent]
  )

  const handleSelectChange = useCallback(
    (value: string) => {
      if (value === AGENT_SELECT_NEW) {
        setShowCreateDialog(true)
        return
      }
      setSelectedAgentId(value)
      persistSelectedAgent(value)
    },
    [persistSelectedAgent]
  )

  const spawnShellTerminal = useCallback(
    async (shell?: ShellInfo) => {
      if (!activeProjectId) {
        toast.error('No active project')
        return
      }
      if (isSpawningTerminal) return

      setIsSpawningTerminal(true)
      try {
        const project = useProjectStore.getState().projects.find((p) => p.id === activeProjectId)
        const cwd = getDefaultCwdForProject(activeProjectId)
        const result = await spawnTerminalInPane(paneId, activeProjectId, cwd, {
          shell: (shell?.path ?? project?.defaultShell ?? appDefaultShell) || undefined,
          envVars: project?.envVars,
          maxTerminalsPerProject: maxTerminals
        })
        if (!result.success) {
          toast.error(result.error || 'Failed to create terminal')
        } else {
          useWorkspaceStore.getState().hideAgentLauncher()
        }
      } finally {
        setIsSpawningTerminal(false)
      }
    },
    [activeProjectId, appDefaultShell, isSpawningTerminal, maxTerminals, paneId]
  )

  const handleAgentCreated = useCallback(
    async (def: TerminalAgentDefinition) => {
      try {
        const saved = await upsertCustomAgent({
          id: def.id,
          name: def.name,
          command: def.command,
          baseArgs: def.baseArgs,
          promptMode: def.promptMode,
          promptFlag: def.promptFlag,
          icon: def.icon,
          registryId: def.registryId,
          env: def.env
        })
        const all = await loadAllAgents()
        setLoadedAgents(all)
        setSelectedAgentId(saved.id)
        persistSelectedAgent(saved.id)
        toast.success(`Added "${def.name}" to your agents`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save agent')
      }
    },
    [persistSelectedAgent]
  )

  const canLaunch = selectedAgent && !isLaunching

  return (
    <div
      className={cn('absolute inset-0 flex flex-col items-center justify-center p-8', className)}
    >
      <div className="flex w-full max-w-xl flex-col gap-3">
        {/* Chat-style input bar — grid layout for clean alignment */}
        <div className="grid grid-cols-[auto_auto_1fr_auto] items-center overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors hover:bg-muted/35 focus-within:border-border/80 focus-within:bg-muted/20 focus-within:ring-1 focus-within:ring-border/50 focus-within:ring-offset-0">
          {/* Agent selector — column 1 */}
          <Select value={selectedAgentId} onValueChange={handleSelectChange}>
            <SelectTrigger className="h-11 w-auto gap-1.5 border-0 bg-transparent pl-3 pr-1 shadow-none hover:bg-muted/40 focus:ring-0 focus:ring-offset-0 [&>svg]:opacity-60">
              <SelectValue>
                <span className="flex items-center gap-1.5">
                  <AgentGlyph agent={selectedAgent} />
                  <span className="max-w-[100px] truncate text-xs font-medium">
                    {selectedAgent?.name ?? 'Agent'}
                  </span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {agents.filter((a) => a.isBuiltIn).length > 0 && (
                <>
                  {agents
                    .filter((a) => a.isBuiltIn)
                    .map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <span className="flex items-center gap-2">
                          <AgentGlyph agent={agent} />
                          {agent.name}
                        </span>
                      </SelectItem>
                    ))}
                </>
              )}
              {agents.filter((a) => !a.isBuiltIn).length > 0 && (
                <>
                  <SelectSeparator />
                  {agents
                    .filter((a) => !a.isBuiltIn)
                    .map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <span className="flex items-center gap-2">
                          <AgentGlyph agent={agent} />
                          {agent.name}
                        </span>
                      </SelectItem>
                    ))}
                </>
              )}
              <SelectSeparator />
              <SelectItem value={AGENT_SELECT_NEW}>
                <span className="flex items-center gap-2 text-primary">
                  <Plus size={12} />
                  New custom agent…
                </span>
              </SelectItem>
            </SelectContent>
          </Select>

          {/* Divider */}
          <div className="h-6 w-px bg-border/50 justify-self-center" />

          {/* Textarea — column 2 (flex-1 via 1fr) */}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you want…"
            rows={1}
            aria-label="Agent prompt"
            autoFocus
            className="min-w-0 resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/60"
            style={{ minHeight: '44px', maxHeight: '120px' }}
            onInput={(e) => {
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`
            }}
          />

          {/* Launch button — column 3 */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canLaunch}
            className={cn(
              'mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-transparent transition-colors',
              canLaunch
                ? 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                : 'text-muted-foreground/35'
            )}
            aria-label={`Launch ${selectedAgent?.name ?? 'agent'}`}
            title={isLaunching ? 'Launching…' : `Launch ${selectedAgent?.name ?? 'agent'}`}
          >
            {isLaunching ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} />}
          </button>
        </div>

        {/* Hint */}
        <span className="text-center text-[11px] text-muted-foreground/50">
          Enter to launch · Shift+Enter for newline · Esc to dismiss
        </span>

        {/* Plain terminal */}
        <div className="flex items-center gap-3 pt-1">
          <div className="h-px flex-1 bg-border/50" aria-hidden />
          <span className="shrink-0 text-[11px] text-muted-foreground/50">or run terminal</span>
          <div className="h-px flex-1 bg-border/50" aria-hidden />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          {sortedShells && sortedShells.length > 0 ? (
            sortedShells.map((shell) => (
              <Button
                key={shell.name}
                type="button"
                variant="outline"
                size="sm"
                disabled={isSpawningTerminal}
                className="h-8 gap-2 text-[11px]"
                onClick={() => void spawnShellTerminal(shell)}
              >
                <TerminalIcon size={12} className="opacity-70" />
                {shell.displayName}
              </Button>
            ))
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSpawningTerminal}
              className="h-8 gap-2 text-[11px]"
              onClick={() => void spawnShellTerminal()}
            >
              <TerminalIcon size={12} className="opacity-70" />
              Default terminal
            </Button>
          )}
        </div>
      </div>

      <CustomAgentDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onAgentCreated={handleAgentCreated}
      />
    </div>
  )
}

const AgentGlyph = memo(function AgentGlyph({
  agent
}: {
  agent: TerminalAgentDefinition
}): React.JSX.Element {
  const normalized = useMemo(() => {
    if (!agent.icon) return null
    return sanitizeInlineAgentSvg(agent.icon)
  }, [agent.icon])

  if (normalized) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-4 shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: icon SVG is sanitized via sanitizeInlineAgentSvg (DOMPurify)
        dangerouslySetInnerHTML={{ __html: normalized }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 items-center justify-center rounded-sm bg-foreground/10 text-[9px] font-semibold uppercase"
    >
      {agent.name.charAt(0)}
    </span>
  )
})
