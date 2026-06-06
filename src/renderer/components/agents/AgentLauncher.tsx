import type { DetectedShells, ShellInfo } from '@shared/types/ipc.types'
import { type LastSelectedAgent, PersistenceKeys } from '@shared/types/persistence.types'
import { ArrowUp, Loader2, Plus, Settings2, Terminal as TerminalIcon, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import {
  type AgentMode,
  buildUnifiedAgents,
  normalizePersistedSelection,
  resolveSelection,
  selectionToPersisted,
  type UnifiedAgentEntry
} from '@/lib/agents/unified-agents'
import { persistenceApi, shellApi } from '@/lib/api'
import { spawnTerminalInPane } from '@/lib/terminal-spawn'
import { cn } from '@/lib/utils'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { prepareChatKey, useAcpStore } from '@/stores/acp-store'
import { useDefaultShell, useMaxTerminalsPerProject } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import {
  buildPromptWithLoadedSkill,
  type LoadedAgentSkill,
  useAgentSkills
} from '@/hooks/use-agent-skills'
import { SlashCommandMenu, type SlashMenuHandle } from '@/components/chat/SlashCommandMenu'
import {
  buildSlashSections,
  isSlashTrigger,
  type SlashItem,
  slashFilter
} from '@/components/chat/slash-menu-model'
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

/** Survives overlay unmount (Ctrl+T) so the selector does not flash the default. */
let cachedSelection: { key: string; mode: AgentMode } | null = null

/** Test-only: clear the cross-unmount selection cache. */
export function __resetLauncherSelectionCache(): void {
  cachedSelection = null
}

export function AgentLauncher({
  paneId,
  agents: agentsProp,
  className
}: AgentLauncherProps): React.JSX.Element {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [loadedSkill, setLoadedSkill] = useState<LoadedAgentSkill | null>(null)
  const menuRef = useRef<SlashMenuHandle>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [loadedAgents, setLoadedAgents] =
    useState<readonly TerminalAgentDefinition[]>(BUILT_IN_AGENTS)
  const cliAgents = agentsProp ?? loadedAgents
  const acpConfigs = useAcpStore((s) => s.agentConfigs)

  const entries = useMemo(() => buildUnifiedAgents(cliAgents, acpConfigs), [cliAgents, acpConfigs])

  const [selectedKey, setSelectedKey] = useState(
    () => cachedSelection?.key ?? entries[0]?.key ?? ''
  )
  const [selectedMode, setSelectedMode] = useState<AgentMode>(
    () => cachedSelection?.mode ?? entries[0]?.modes[0] ?? 'cli'
  )
  const [isLaunching, setIsLaunching] = useState(false)
  const [isSpawningTerminal, setIsSpawningTerminal] = useState(false)
  const [shells, setShells] = useState<DetectedShells | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  const persistSelection = useCallback((entry: UnifiedAgentEntry, mode: AgentMode) => {
    const persisted = selectionToPersisted(entry, mode)
    if (!persisted) return
    cachedSelection = { key: entry.key, mode }
    void persistenceApi.write<LastSelectedAgent>(PersistenceKeys.lastSelectedAgent, persisted)
  }, [])

  useEffect(() => {
    if (agentsProp) return
    let cancelled = false
    void (async () => {
      try {
        const all = await loadAllAgents()
        if (cancelled) return
        if (all.length > 0) setLoadedAgents(all)
      } catch {
        // Keep built-in default when agent load fails.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentsProp])

  // Restore the persisted { agentId, mode } once entries are available, migrating
  // legacy { agentId } records to mode 'cli'. Runs until a match resolves so the
  // async agent/config load doesn't leave the default selected.
  useEffect(() => {
    if (cachedSelection || entries.length === 0) return
    let cancelled = false
    void (async () => {
      try {
        const persisted = await persistenceApi.read<unknown>(PersistenceKeys.lastSelectedAgent)
        if (cancelled) return
        const saved = persisted.success ? normalizePersistedSelection(persisted.data) : null
        const resolved = resolveSelection(entries, saved)
        if (resolved) {
          cachedSelection = resolved
          setSelectedKey(resolved.key)
          setSelectedMode(resolved.mode)
        }
      } catch {
        // Keep the default selection when persistence read fails.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [entries])

  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projectRoot = activeProjectId ? getDefaultCwdForProject(activeProjectId) : undefined
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

  const selectedEntry = useMemo(
    () => entries.find((e) => e.key === selectedKey) ?? entries[0],
    [entries, selectedKey]
  )

  // The mode actually used: the selection if supported, else the entry's first.
  const effectiveMode: AgentMode = useMemo(() => {
    if (!selectedEntry) return 'cli'
    return selectedEntry.modes.includes(selectedMode) ? selectedMode : selectedEntry.modes[0]
  }, [selectedEntry, selectedMode])

  const { skills } = useAgentSkills(effectiveMode === 'acp' ? projectRoot : undefined)
  const menuOpen = effectiveMode === 'acp' && isSlashTrigger(prompt)
  const slashSections = useMemo(
    () =>
      menuOpen
        ? buildSlashSections({
            commands: [],
            configOptions: [],
            modes: null,
            skills,
            filter: slashFilter(prompt)
          })
        : [],
    [menuOpen, skills, prompt]
  )

  useEffect(() => {
    if (effectiveMode !== 'acp') setLoadedSkill(null)
  }, [effectiveMode])

  const handleSlashSelect = useCallback((item: SlashItem) => {
    if (item.kind !== 'skill') return
    setLoadedSkill({ name: item.name, description: item.description ?? '' })
    setPrompt('')
    textareaRef.current?.focus()
  }, [])

  // When an ACP agent is selected with a resolvable cwd, prepare a session in
  // the background (best-effort, deduped by the store) so the eventual send
  // reuses it instead of paying spawn + initialize + session/new on the
  // critical path. `startChat` consumes any prepared session for this key.
  //
  // The cleanup reaps an unconsumed prepared session when the selection changes
  // or the launcher unmounts without launching — otherwise abandoning an ACP
  // selection (dismiss, switch agent/mode, change project) would leak a live
  // backend session and a phantom history entry. `cancelPreparedChat` is a
  // no-op once `startChat` has consumed the key, and never reaps the session
  // the user actually navigated to.
  useEffect(() => {
    if (effectiveMode !== 'acp' || !selectedEntry?.acp || !activeProjectId) return
    const cwd = getDefaultCwdForProject(activeProjectId)
    const trimmedCwd = cwd?.trim() ?? ''
    if (trimmedCwd.length === 0) return
    const configId = selectedEntry.acp.id
    useAcpStore.getState().prepareChat(configId, trimmedCwd)
    const key = prepareChatKey(configId, trimmedCwd, undefined)
    return () => {
      useAcpStore.getState().cancelPreparedChat(key)
    }
  }, [effectiveMode, selectedEntry, activeProjectId])

  const launchCli = useCallback(
    async (agent: TerminalAgentDefinition): Promise<void> => {
      const project = useProjectStore.getState().projects.find((p) => p.id === activeProjectId)
      const cwd = getDefaultCwdForProject(activeProjectId as string)
      const result = await launchAgentInPane(
        paneId,
        activeProjectId as string,
        cwd,
        agent,
        prompt,
        {
          envVars: project?.envVars,
          maxTerminalsPerProject: maxTerminals
        }
      )
      if (!result.success) {
        toast.error(result.error || 'Failed to launch agent')
        return
      }
      useWorkspaceStore.getState().hideAgentLauncher()
    },
    [activeProjectId, maxTerminals, paneId, prompt]
  )

  const launchAcp = useCallback(
    async (configId: string): Promise<void> => {
      const cwd = getDefaultCwdForProject(activeProjectId as string)
      const sessionId = await useAcpStore.getState().startChat(configId, cwd)
      useWorkspaceStore.getState().addAgentChatTab(sessionId, paneId)
      const text = await buildPromptWithLoadedSkill(loadedSkill, prompt, projectRoot)
      if (text.trim().length > 0) {
        void useAcpStore.getState().sendPrompt(sessionId, text.trim())
      }
      setLoadedSkill(null)
      useWorkspaceStore.getState().hideAgentLauncher()
    },
    [activeProjectId, paneId, prompt, loadedSkill, projectRoot]
  )

  const launch = useCallback(
    async (entry: UnifiedAgentEntry | undefined, mode: AgentMode) => {
      if (!entry) return
      if (!activeProjectId) {
        toast.error('No active project')
        return
      }
      if (isLaunching) return

      setIsLaunching(true)
      try {
        if (mode === 'cli' && entry.cli) {
          persistSelection(entry, 'cli')
          await launchCli(entry.cli)
        } else if (mode === 'acp' && entry.acp) {
          persistSelection(entry, 'acp')
          await launchAcp(entry.acp.id)
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to launch agent')
      } finally {
        setIsLaunching(false)
      }
    },
    [activeProjectId, isLaunching, launchCli, launchAcp, persistSelection]
  )

  const handleSubmit = useCallback(() => {
    void launch(selectedEntry, effectiveMode)
  }, [launch, selectedEntry, effectiveMode])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (menuOpen && slashSections.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          menuRef.current?.move(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          menuRef.current?.move(-1)
          return
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          menuRef.current?.selectHighlighted()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setPrompt('')
          return
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void launch(selectedEntry, effectiveMode)
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !menuOpen) {
        e.preventDefault()
        void launch(selectedEntry, effectiveMode)
      }
      if (e.key === 'Escape' && !menuOpen) {
        useWorkspaceStore.getState().hideAgentLauncher()
      }
    },
    [launch, selectedEntry, effectiveMode, menuOpen, slashSections.length]
  )

  const handleSelectChange = useCallback(
    (value: string) => {
      if (value === AGENT_SELECT_NEW) {
        setShowCreateDialog(true)
        return
      }
      const entry = entries.find((e) => e.key === value)
      if (!entry) return
      const mode = entry.modes.includes(selectedMode) ? selectedMode : entry.modes[0]
      setSelectedKey(value)
      setSelectedMode(mode)
      persistSelection(entry, mode)
    },
    [entries, selectedMode, persistSelection]
  )

  const handleModeChange = useCallback(
    (mode: AgentMode) => {
      if (!selectedEntry?.modes.includes(mode)) return
      setSelectedMode(mode)
      persistSelection(selectedEntry, mode)
    },
    [selectedEntry, persistSelection]
  )

  const openAgentSettings = useCallback(() => {
    useWorkspaceStore.getState().hideAgentLauncher()
    navigate('/preferences')
  }, [navigate])

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

  const handleAgentCreated = useCallback(async (def: TerminalAgentDefinition) => {
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
      setSelectedKey(`cli:${saved.id}`)
      setSelectedMode('cli')
      cachedSelection = { key: `cli:${saved.id}`, mode: 'cli' }
      void persistenceApi.write<LastSelectedAgent>(PersistenceKeys.lastSelectedAgent, {
        agentId: saved.id,
        mode: 'cli'
      })
      toast.success(`Added "${def.name}" to your agents`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save agent')
    }
  }, [])

  const canLaunch =
    Boolean(selectedEntry) &&
    !isLaunching &&
    (effectiveMode !== 'acp' || prompt.trim().length > 0 || loadedSkill !== null)

  return (
    <div
      className={cn('absolute inset-0 flex flex-col items-center justify-center p-8', className)}
    >
      <div className="flex w-full max-w-xl flex-col gap-3">
        <div className="relative">
          {menuOpen && (
            <SlashCommandMenu
              ref={menuRef}
              sections={slashSections}
              onSelect={handleSlashSelect}
            />
          )}
          {loadedSkill && effectiveMode === 'acp' && (
            <div className="mb-1 flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-1.5">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                Skill:{' '}
                <span className="font-medium text-foreground break-words">{loadedSkill.name}</span>
              </span>
              <button
                type="button"
                onClick={() => setLoadedSkill(null)}
                className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                aria-label="Remove loaded skill"
                title="Remove skill"
              >
                <X size={12} />
              </button>
            </div>
          )}
        {/* Chat-style input bar — grid layout for clean alignment */}
        <div className="grid grid-cols-[auto_auto_auto_1fr_auto] items-center overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors hover:bg-muted/35 focus-within:border-border/80 focus-within:bg-muted/20 focus-within:ring-1 focus-within:ring-border/50 focus-within:ring-offset-0">
          {/* Agent selector — column 1 */}
          <Select value={selectedKey} onValueChange={handleSelectChange}>
            <SelectTrigger className="h-11 w-auto gap-1.5 border-0 bg-transparent pl-3 pr-1 shadow-none hover:bg-muted/40 focus:ring-0 focus:ring-offset-0 [&>svg]:opacity-60">
              <SelectValue>
                <span className="flex items-center gap-1.5">
                  <EntryGlyph entry={selectedEntry} />
                  <span className="max-w-[100px] truncate text-xs font-medium">
                    {selectedEntry?.name ?? 'Agent'}
                  </span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {entries.length === 0 ? (
                <button
                  type="button"
                  onClick={openAgentSettings}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-xs text-primary hover:bg-muted/40"
                >
                  <Settings2 size={12} />
                  Enable an agent in Settings…
                </button>
              ) : (
                <>
                  {entries
                    .filter((e) => e.isBuiltIn)
                    .map((entry) => (
                      <SelectItem key={entry.key} value={entry.key}>
                        <EntryRow entry={entry} />
                      </SelectItem>
                    ))}
                  {entries.some((e) => e.isBuiltIn) && entries.some((e) => !e.isBuiltIn) && (
                    <SelectSeparator />
                  )}
                  {entries
                    .filter((e) => !e.isBuiltIn)
                    .map((entry) => (
                      <SelectItem key={entry.key} value={entry.key}>
                        <EntryRow entry={entry} />
                      </SelectItem>
                    ))}
                  <SelectSeparator />
                  <SelectItem value={AGENT_SELECT_NEW}>
                    <span className="flex items-center gap-2 text-primary">
                      <Plus size={12} />
                      New custom agent…
                    </span>
                  </SelectItem>
                </>
              )}
            </SelectContent>
          </Select>

          {/* CLI/ACP mode toggle — column 2 (only for dual-mode agents) */}
          {selectedEntry && selectedEntry.modes.length > 1 ? (
            <div className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5">
              {(['cli', 'acp'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleModeChange(mode)}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase transition-colors',
                    effectiveMode === mode
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  aria-pressed={effectiveMode === mode}
                  aria-label={`Run as ${mode.toUpperCase()}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          ) : (
            <span
              className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground"
              title={`This agent runs as ${effectiveMode.toUpperCase()}`}
            >
              {effectiveMode}
            </span>
          )}

          {/* Divider */}
          <div className="h-6 w-px bg-border/50 justify-self-center" />

          {/* Textarea — column 2 (flex-1 via 1fr) */}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              effectiveMode === 'acp'
                ? loadedSkill
                  ? 'Add a message (optional)…'
                  : 'Describe what you want… (/ for skills)'
                : 'Describe what you want…'
            }
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
            aria-label={`Launch ${selectedEntry?.name ?? 'agent'}`}
            title={isLaunching ? 'Launching…' : `Launch ${selectedEntry?.name ?? 'agent'}`}
          >
            {isLaunching ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} />}
          </button>
        </div>
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

/** Protocol-tagged selector row: icon + name + mode badge(s). */
function EntryRow({ entry }: { entry: UnifiedAgentEntry }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <EntryGlyph entry={entry} />
      <span className="flex-1 truncate">{entry.name}</span>
      <span className="flex items-center gap-1">
        {entry.modes.map((mode) => (
          <span
            key={mode}
            className="rounded bg-foreground/10 px-1 text-[9px] font-semibold uppercase text-muted-foreground"
          >
            {mode}
          </span>
        ))}
      </span>
    </span>
  )
}

const EntryGlyph = memo(function EntryGlyph({
  entry
}: {
  entry: UnifiedAgentEntry | undefined
}): React.JSX.Element {
  const normalized = useMemo(() => {
    if (!entry?.iconSvg) return null
    return sanitizeInlineAgentSvg(entry.iconSvg)
  }, [entry?.iconSvg])

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
      {entry?.name.charAt(0) ?? 'A'}
    </span>
  )
})
