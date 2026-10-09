import { useState } from 'react'
import { toast } from 'sonner'
import { ConfigChip, ModeChip } from '@/components/chat/AgentHeader'
import { AttachFilesButton } from '@/components/chat/AttachFilesButton'
import { FastModeToggle } from '@/components/chat/FastModeToggle'
import { McpBadge } from '@/components/chat/McpBadge'
import { ArrowUp } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { pressedToggleClass } from '@/components/ui/panel-styles'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AuthMethod, McpToolInfo, ProbeStatus, SessionConfigOption } from '@/lib/acp-api'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { cn } from '@/lib/utils'
import { type AcpSession, useAcpStore } from '@/stores/acp-store'
import { AgentUpdateCta } from './AgentUpdateCta'
import { AcpAgentPicker, AcpModelPicker } from './pickers'

/**
 * The composer card's bottom row: attachments + MCP badge on the left; the
 * update CTA, agent/model pickers, config chips (thought level, fast mode,
 * generics, mode) and the launch button on the right.
 */
export function LauncherToolbar({
  pickFiles,
  canPick,
  isMobileShell,
  mcpCount,
  mcpServers,
  setMcpServerEnabled,
  preparedKey,
  activeConfigId,
  projectRoot,
  activeProjectId,
  mcpProbeStatus,
  mcpProbeError,
  mcpTools,
  loadMcpTools,
  selectedEntry,
  selectedUpdateAgent,
  pendingRestartVersion,
  updatingSelected,
  restartingUpdatedAgent,
  handleSelectedAgentUpdate,
  handleRestartUpdatedAgent,
  supportedAgents,
  selectedConfig,
  installingConfigId,
  savingManualPath,
  updateAgentIds,
  handleSelectAgent,
  modelOption,
  showModelLoading,
  prepareError,
  hasCachedModels,
  signInMethod,
  handleSignIn,
  optionsInteractive,
  handleRetryPrepare,
  handleSetModel,
  thoughtLevel,
  modelConfig,
  handleSetConfig,
  fastMode,
  nonFastGenericOptions,
  modePreviewSession,
  handleSetMode,
  canLaunch,
  launch
}: {
  pickFiles: () => Promise<void>
  canPick: boolean
  isMobileShell: boolean
  mcpCount: number
  mcpServers: StoredMcpServer[]
  setMcpServerEnabled: (id: string, enabled: boolean) => Promise<void>
  preparedKey: string | null
  activeConfigId: string
  projectRoot: string | undefined
  activeProjectId: string
  mcpProbeStatus: Record<string, ProbeStatus>
  mcpProbeError: Record<string, string | undefined>
  mcpTools: Record<string, McpToolInfo[]>
  loadMcpTools: (id: string) => Promise<void>
  selectedEntry: SupportedAcpAgentEntry | null
  selectedUpdateAgent: RegistryAgent | null
  pendingRestartVersion: string | null
  updatingSelected: boolean
  restartingUpdatedAgent: boolean
  handleSelectedAgentUpdate: () => void
  handleRestartUpdatedAgent: () => void
  supportedAgents: readonly SupportedAcpAgentEntry[]
  selectedConfig: StoredAgentConfig | null
  installingConfigId: string | null
  savingManualPath: boolean
  updateAgentIds: ReadonlySet<string>
  handleSelectAgent: (entry: SupportedAcpAgentEntry) => void
  modelOption: SessionConfigOption | null
  showModelLoading: boolean
  prepareError: PrepareChatError | null
  hasCachedModels: boolean
  signInMethod: AuthMethod | null
  handleSignIn: () => void
  optionsInteractive: boolean
  handleRetryPrepare: () => void
  handleSetModel: (valueId: string) => Promise<void>
  thoughtLevel: SessionConfigOption | null
  modelConfig: SessionConfigOption[]
  handleSetConfig: (configId: string, valueId: string | boolean) => Promise<void>
  fastMode: SessionConfigOption | null
  nonFastGenericOptions: SessionConfigOption[]
  modePreviewSession: AcpSession | null
  handleSetMode: (modeId: string) => Promise<void>
  canLaunch: boolean
  launch: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 px-3 pb-3">
      <div className="flex min-w-0 items-center gap-2">
        <AttachFilesButton
          onClick={() => void pickFiles()}
          disabled={!canPick}
          className={isMobileShell ? 'size-11' : undefined}
        />
        <McpBadge
          count={mcpCount}
          servers={mcpServers}
          onToggle={(id, enabled) => {
            void setMcpServerEnabled(id, enabled)
              .then(() => {
                if (!preparedKey || !activeConfigId || !projectRoot) return
                const store = useAcpStore.getState()
                store.cancelPreparedChat(preparedKey)
                store.prepareChat(activeConfigId, projectRoot, undefined, activeProjectId)
              })
              .catch(() => {
                toast.error('Could not update the MCP server. Your previous setting was restored.')
              })
          }}
          probeStatus={mcpProbeStatus}
          probeError={mcpProbeError}
          tools={mcpTools}
          onLoadTools={(id) => {
            void loadMcpTools(id)
          }}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2.5">
        {selectedEntry && (selectedUpdateAgent || pendingRestartVersion) && (
          // One CTA communicates the full lifecycle: Update → Updating
          // → Restart. The Restart action opens a new chat on the new
          // version; currently open chats are deliberately preserved.
          <AgentUpdateCta
            agentName={selectedEntry.config?.name ?? selectedEntry.agent.name}
            version={pendingRestartVersion ?? selectedUpdateAgent?.version ?? ''}
            updating={updatingSelected}
            restarting={restartingUpdatedAgent}
            restartAvailable={pendingRestartVersion !== null}
            onUpdate={handleSelectedAgentUpdate}
            onRestart={handleRestartUpdatedAgent}
          />
        )}
        <AcpAgentPicker
          agents={supportedAgents}
          selectedEntry={selectedEntry}
          selectedConfig={selectedConfig}
          disabled={Boolean(installingConfigId) || savingManualPath}
          installingConfigId={installingConfigId}
          updateAgentIds={updateAgentIds}
          onSelectAgent={handleSelectAgent}
        />
        <AcpModelPicker
          selectedEntry={selectedEntry}
          modelOption={modelOption}
          loading={showModelLoading}
          connecting={false}
          stale={Boolean(prepareError && hasCachedModels)}
          setupError={prepareError}
          signInMethod={signInMethod}
          onSignIn={() => void handleSignIn()}
          disabled={
            Boolean(installingConfigId) ||
            savingManualPath ||
            (!optionsInteractive && !prepareError)
          }
          onRetry={handleRetryPrepare}
          onSelectModel={handleSetModel}
        />
        {thoughtLevel && (
          <ConfigChip
            option={thoughtLevel}
            disabled={!optionsInteractive}
            promoted
            onSelect={(valueId) => void handleSetConfig(thoughtLevel.id, valueId)}
          />
        )}
        {modelConfig.map((option) =>
          option.type === 'boolean' ? (
            <BooleanOptionPill
              key={option.id}
              option={option}
              disabled={!optionsInteractive}
              onToggle={(value) => {
                void handleSetConfig(option.id, value).catch(() => {})
              }}
            />
          ) : (
            <ConfigChip
              key={option.id}
              option={option}
              disabled={!optionsInteractive}
              onSelect={(valueId) => {
                void handleSetConfig(option.id, valueId).catch(() => {})
              }}
            />
          )
        )}
        {fastMode && (
          <FastModeToggle
            option={fastMode}
            disabled={!optionsInteractive}
            onSelect={(valueId) => void handleSetConfig(fastMode.id, valueId)}
          />
        )}
        {nonFastGenericOptions.map((option) =>
          option.type === 'boolean' ? (
            <BooleanOptionPill
              key={option.id}
              option={option}
              disabled={!optionsInteractive}
              onToggle={(value) => {
                void handleSetConfig(option.id, value).catch(() => {})
              }}
            />
          ) : (
            <ConfigChip
              key={option.id}
              option={option}
              disabled={!optionsInteractive}
              onSelect={(valueId) => void handleSetConfig(option.id, valueId)}
            />
          )
        )}
        {modePreviewSession && (
          <ModeChip
            session={modePreviewSession}
            disabled={!optionsInteractive}
            onSelect={handleSetMode}
            label="Agent"
          />
        )}
        <Button
          type="button"
          variant="composer"
          size={isMobileShell ? 'touch' : 'icon'}
          onClick={() => launch()}
          disabled={!canLaunch}
          className={cn('shrink-0', isMobileShell ? 'w-11 [&_svg]:size-5' : '[&_svg]:size-[18px]')}
          aria-label="Start agent chat"
          title="Start agent chat"
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
  )
}

/** On/off control for an ACP boolean config option. Select chips stay menus. */
function BooleanOptionPill({
  option,
  disabled,
  onToggle
}: {
  option: SessionConfigOption
  disabled: boolean
  onToggle: (value: boolean) => void
}): React.JSX.Element {
  const advertised = option.currentValue === true
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const on = optimistic ?? advertised
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      className={cn('shrink-0 rounded-full border px-2.5 py-1 text-xs', pressedToggleClass(on))}
      onClick={() => {
        const next = !on
        setOptimistic(next)
        void Promise.resolve(onToggle(next)).finally(() => setOptimistic(null))
      }}
    >
      {option.name}
    </button>
  )
}
