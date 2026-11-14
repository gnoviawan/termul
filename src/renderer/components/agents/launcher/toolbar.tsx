import { CODEX_AGENT_CONFIG_ID } from '@shared/types/codex-accounts.types'
import { toast } from 'sonner'
import { ModeChip } from '@/components/chat/AgentHeader'
import {
  AgentModelSelector,
  type PhoneSelectorControls
} from '@/components/chat/agent-model-selector/AgentModelSelector'
import type { SelectorSource } from '@/components/chat/agent-model-selector/selector-source'
import type { ComposerToolbarMode } from '@/components/chat/chat-layout'
import { ProjectClaudeAccountChip } from '@/components/chat/claude-account/ClaudeAccountChip'
import { ProjectCodexAccountChip } from '@/components/chat/codex-account/CodexAccountChip'
import { ComposerAddMenu } from '@/components/chat/composer/ComposerAddMenu'
import {
  type ComposerAddHandle,
  ComposerAddSheet
} from '@/components/chat/composer/ComposerAddSheet'
import { useTermulTools } from '@/components/chat/composer/use-termul-tools'
import { ArrowUp } from '@/components/icons'
import { Button } from '@/components/ui/button'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { McpToolInfo, ProbeStatus, SessionConfigOption } from '@/lib/acp-api'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { cn } from '@/lib/utils'
import { type AcpSession, useAcpStore } from '@/stores/acp-store'
import type { OptionValues } from '@/stores/acp-store/composer-options'
import { CLAUDE_AGENT_CONFIG_ID } from '@/stores/claude-account-switch'
import { AgentUpdateCta } from './AgentUpdateCta'

/**
 * The composer card's bottom row: the + menu (attachments, mentions,
 * commands, connectors) and the Claude account chip on the left; the update CTA, the agent/model selector (agent,
 * model, effort, Fast, agent options), the mode chip, and the launch button on
 * the right. On the phone shell it is the chat composer's row: the + sheet
 * (attachments, mentions, commands, connectors), the model pill, and launch.
 * The Select model sheet holds the mode and the Claude account.
 */
export function LauncherToolbar({
  addHandle,
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
  selectedConfig,
  installingConfigId,
  savingManualPath,
  selectorSource,
  modelOption,
  modelSource,
  optionsInteractive,
  handleSetModel,
  thoughtLevel,
  modelConfig,
  handleSetConfig,
  fastMode,
  nonFastGenericOptions,
  modePreviewSession,
  handleSetMode,
  canLaunch,
  launch,
  onSelectorCloseAutoFocus,
  toolbarMode
}: {
  /** The + sheet's and + menu's handle into the launcher's attachments and editor. */
  addHandle: ComposerAddHandle
  isMobileShell: boolean
  toolbarMode: ComposerToolbarMode
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
  selectedConfig: StoredAgentConfig | null
  installingConfigId: string | null
  savingManualPath: boolean
  selectorSource: SelectorSource
  modelOption: SessionConfigOption | null
  modelSource: 'config' | 'models' | null
  optionsInteractive: boolean
  handleSetModel: (valueId: string, values?: OptionValues) => Promise<void>
  thoughtLevel: SessionConfigOption | null
  modelConfig: SessionConfigOption[]
  handleSetConfig: (configId: string, valueId: string | boolean) => Promise<void>
  fastMode: SessionConfigOption | null
  nonFastGenericOptions: SessionConfigOption[]
  modePreviewSession: AcpSession | null
  handleSetMode: (modeId: string) => Promise<void>
  canLaunch: boolean
  launch: () => Promise<void>
  /**
   * Deferred composer focus after an in-popover agent pick (see
   * AgentLauncher.handleSelectorCloseAutoFocus): fires when the selector
   * finishes closing, after Radix's own close-focus pass.
   */
  onSelectorCloseAutoFocus?: (event: Event) => void
}): React.JSX.Element {
  const termulTools = useTermulTools(activeProjectId || null)
  const claudeProjectId =
    selectedEntry?.configId === CLAUDE_AGENT_CONFIG_ID && activeProjectId ? activeProjectId : null
  const codexProjectId =
    selectedEntry?.configId === CODEX_AGENT_CONFIG_ID && activeProjectId ? activeProjectId : null
  const mcpListProps = {
    count: mcpCount,
    servers: mcpServers,
    onToggle: (id: string, enabled: boolean) => {
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
    },
    probeStatus: mcpProbeStatus,
    probeError: mcpProbeError,
    tools: mcpTools,
    onLoadTools: (id: string) => {
      void loadMcpTools(id)
    }
  }
  const updateCta =
    selectedEntry && (selectedUpdateAgent || pendingRestartVersion) ? (
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
    ) : null
  // One control for agent, model, effort, Fast, and agent options: the same
  // selector as a chat, with the launcher's draft as its source.
  const selector = (phone?: PhoneSelectorControls) => (
    <AgentModelSelector
      draft={{
        source: selectorSource,
        agentName: selectedConfig?.name ?? selectedEntry?.agent.name ?? null
      }}
      disabled={Boolean(installingConfigId) || savingManualPath}
      busy={false}
      modelOption={modelOption}
      modelSource={modelSource}
      thoughtLevel={optionsInteractive ? thoughtLevel : null}
      fastMode={optionsInteractive ? fastMode : null}
      agentTemplateId={selectedConfig?.templateId ?? selectedEntry?.agent.id ?? null}
      agentIcon={selectedConfig?.icon ?? null}
      genericOptions={optionsInteractive ? [...modelConfig, ...nonFastGenericOptions] : []}
      onSetConfig={handleSetConfig}
      onSetModel={handleSetModel}
      onCloseAutoFocus={onSelectorCloseAutoFocus}
      phone={phone}
    />
  )
  const launchButton = (
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
  )

  if (isMobileShell) {
    return (
      <div
        className="flex items-center justify-between gap-3 px-2 pb-2"
        data-composer-toolbar={toolbarMode}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2" data-composer-toolbar-row="mobile">
          <ComposerAddSheet
            handle={addHandle}
            disabled={!addHandle.canPick}
            termulTools={termulTools}
            connectorsHost="launcher"
            {...mcpListProps}
          />
          {selector({
            modes: optionsInteractive ? (modePreviewSession?.modes ?? null) : null,
            onSetMode: handleSetMode,
            compact: null,
            claudeProjectId
          })}
          {codexProjectId ? <ProjectCodexAccountChip projectId={codexProjectId} /> : null}
          <div className="flex-1" />
          {updateCta}
          {launchButton}
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex items-center justify-between gap-3 px-2 pb-2"
      data-composer-toolbar={toolbarMode}
    >
      <div className="flex min-w-0 items-center gap-3">
        <ComposerAddMenu
          handle={addHandle}
          disabled={!addHandle.canPick}
          connectors={mcpListProps}
          connectorsHost="launcher"
          termulTools={termulTools}
        />
        {claudeProjectId ? <ProjectClaudeAccountChip projectId={claudeProjectId} /> : null}
        {codexProjectId ? <ProjectCodexAccountChip projectId={codexProjectId} /> : null}
      </div>
      <div
        className={cn(
          'flex min-w-0 items-center justify-end gap-2.5',
          toolbarMode === 'narrow' && 'flex-1'
        )}
      >
        {(() => {
          // The chat composer's #859 pattern: a narrow toolbar scrolls its
          // chip rows horizontally instead of wrapping into stacked lines.
          // The launch button stays a fixed sibling so it never scrolls away.
          const chips = (
            <>
              {updateCta}
              {selector()}
              {modePreviewSession && (
                <ModeChip
                  session={modePreviewSession}
                  disabled={!optionsInteractive}
                  onSelect={handleSetMode}
                  label="Agent"
                  agentName={selectedConfig?.name}
                />
              )}
            </>
          )
          return toolbarMode === 'narrow' ? (
            <div
              className="flex min-w-0 max-w-full items-center justify-end gap-2 overflow-x-auto scrollbar-hide"
              data-composer-toolbar-row="1"
            >
              {chips}
            </div>
          ) : (
            <div
              className="flex min-w-0 flex-wrap items-center justify-end gap-2.5"
              data-composer-toolbar-row="single"
            >
              {chips}
            </div>
          )
        })()}
        {launchButton}
      </div>
    </div>
  )
}
