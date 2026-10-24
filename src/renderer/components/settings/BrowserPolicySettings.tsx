import {
  APP_PREAPPROVABLE_ACTIONS,
  PROJECT_PREAPPROVABLE_ACTIONS
} from '@shared/types/browser-policy.types'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useAppBrowserPolicy, useProjectBrowserPolicy } from '@/hooks/use-browser-policy'
import type { BrowserPolicyFailure } from '@/lib/browser-policy-api'
import { OriginListEditor, PreapprovalEditor } from './BrowserPolicyEditors'
import { BROWSER_ANCHORS, describeFailure } from './browser-policy-copy'
import { SettingsCard, SettingsGroup } from './SettingsGroup'
import { SettingsNotice } from './SettingsNotice'
import { SettingsRow, settingsDescriptionId } from './SettingsRow'

function Loading(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Spinner size={14} decorative />
      Loading browser rules…
    </div>
  )
}

function ReadOnlyNotice(): React.JSX.Element {
  return (
    <SettingsNotice>
      These rules were saved by a newer version of Termul, or their file is damaged. You can read
      them but not change them.
    </SettingsNotice>
  )
}

function Failure({ message }: { message: string }): React.JSX.Element {
  return (
    <SettingsNotice tone="danger" role="alert">
      {message}
    </SettingsNotice>
  )
}

interface SwitchRowProps {
  /** Anchor id for settings search. */
  id: string
  /** Control id; the row label names it. */
  controlId: string
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onToggle: (enabled: boolean) => void
}

function SwitchRow({
  id,
  controlId,
  label,
  description,
  checked,
  disabled,
  onToggle
}: SwitchRowProps): React.JSX.Element {
  return (
    <SettingsRow
      id={id}
      htmlFor={controlId}
      label={label}
      description={description}
      layout="inline"
      disabled={disabled}
    >
      <Switch
        id={controlId}
        aria-describedby={settingsDescriptionId(controlId)}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
      />
    </SettingsRow>
  )
}

/** Keeps the failure sentence of the last switch edit. */
function useSwitchEdit(): {
  error: string | null
  settle: (failure: BrowserPolicyFailure | null) => void
} {
  const [error, setError] = useState<string | null>(null)
  return {
    error,
    settle: (failure) => setError(failure ? describeFailure(failure) : null)
  }
}

/** What agents may do in the browser for one project. Edits save as you make them. */
export function BrowserProjectPolicy({ projectId }: { projectId: string }): React.JSX.Element {
  const { state, edit } = useProjectBrowserPolicy(projectId)
  const { error: switchError, settle } = useSwitchEdit()

  if (state.status === 'loading') return <Loading />
  if (state.status === 'error') return <Failure message={describeFailure(state.failure)} />
  const { policy } = state
  const locked = policy.readOnly

  return (
    <>
      {locked && <ReadOnlyNotice />}
      <SettingsGroup
        title="Sign-in"
        footnote="Changes on this page save as you make them."
        className="scroll-mt-4"
      >
        <SettingsCard>
          <SwitchRow
            id={BROWSER_ANCHORS.projectEphemeral}
            controlId="browser-project-ephemeral"
            label="Browse logged out in this project"
            description="Agent tabs start logged out and everything they save is deleted when the chat ends. Off: agents use the shared agent profile."
            checked={policy.profileMode === 'ephemeral'}
            disabled={locked}
            onToggle={(ephemeral) => {
              void edit({ op: 'set_ephemeral', ephemeral }).then(settle)
            }}
          />
        </SettingsCard>
        {policy.profileMode === 'global' && policy.effectiveProfileMode === 'ephemeral' && (
          <SettingsNotice>
            Agents browse logged out in this project for now: the shared agent profile is off or
            this system cannot keep one.
          </SettingsNotice>
        )}
        {switchError && (
          <SettingsNotice tone="danger" role="alert">
            {switchError}
          </SettingsNotice>
        )}
      </SettingsGroup>
      <OriginListEditor
        id={BROWSER_ANCHORS.projectAllowList}
        label="Allowed sites"
        description="Agents open these without asking. Use https://*.example.com for every subdomain."
        placeholder="https://example.com"
        entries={policy.allowList}
        disabled={locked}
        onAdd={(origin) => edit({ op: 'add_origin', origin })}
        onRemove={(origin) => edit({ op: 'remove_origin', origin })}
      />
      <PreapprovalEditor
        id={BROWSER_ANCHORS.projectPreapprovals}
        label="Pre-approved actions"
        description="Agents skip the question for these when they browse logged out in this project. The shared agent profile uses the list in Preferences."
        actions={PROJECT_PREAPPROVABLE_ACTIONS}
        entries={policy.preapprovals}
        disabled={locked}
        onAdd={({ action, origin }) => edit({ op: 'add_preapproval', action, origin })}
        onRemove={({ action, origin }) => edit({ op: 'remove_preapproval', action, origin })}
      />
    </>
  )
}

function clearMessage(sessions: number, projects: number): string {
  if (sessions === 0) {
    return 'The agent signs out of every site. No agent browser tabs are open right now.'
  }
  const chats = `${sessions} ${sessions === 1 ? 'chat' : 'chats'}`
  const scope = `${projects} ${projects === 1 ? 'project' : 'projects'}`
  return `The agent signs out of every site and ${chats} in ${scope} lose their agent browser tabs.`
}

/** What agents may do in the browser in every project. Edits save as you make them. */
export function BrowserAppPolicy(): React.JSX.Element {
  const { state, edit } = useAppBrowserPolicy()
  const { error: switchError, settle } = useSwitchEdit()
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  if (state.status === 'loading') return <Loading />
  if (state.status === 'error') return <Failure message={describeFailure(state.failure)} />
  const { policy } = state
  const locked = policy.readOnly

  const clear = async (): Promise<void> => {
    setClearing(true)
    const failure = await edit({ op: 'clear_global_profile' })
    setClearing(false)
    setConfirming(false)
    setClearError(failure ? describeFailure(failure) : null)
  }

  return (
    <>
      {locked && <ReadOnlyNotice />}
      <SettingsGroup
        title="Agent profile"
        footnote="Changes on this page save as you make them."
        className="scroll-mt-4"
      >
        <SettingsCard>
          <SwitchRow
            id={BROWSER_ANCHORS.appProfile}
            controlId="browser-shared-profile"
            label="Shared agent profile"
            description="One agent profile for every project keeps logins between chats. Off: agents always browse logged out."
            checked={policy.globalProfileEnabled}
            disabled={locked}
            onToggle={(enabled) => {
              void edit({ op: 'set_global_profile', enabled }).then(settle)
            }}
          />
          <SwitchRow
            id={BROWSER_ANCHORS.appPasswordPrompt}
            controlId="browser-password-prompt"
            label="Ask before an agent submits a password"
            description="Off: agents sign in to sites without asking you first."
            checked={policy.askBeforePasswordSubmit}
            disabled={locked}
            onToggle={(enabled) => {
              void edit({ op: 'set_ask_before_password_submit', enabled }).then(settle)
            }}
          />
          <SettingsRow
            id={BROWSER_ANCHORS.appClear}
            label="Logins and site data"
            description="Closes agent browser tabs that use the shared profile and deletes its logins and site data."
            layout="inline"
          >
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={locked}
              onClick={() => setConfirming(true)}
            >
              Clear agent profile
            </Button>
          </SettingsRow>
        </SettingsCard>
        {policy.globalProfileEnabled && !policy.effectiveGlobalProfile && (
          <SettingsNotice>
            This system cannot keep a shared agent profile, so agents browse logged out. It needs
            macOS 14 or later.
          </SettingsNotice>
        )}
        {(switchError ?? clearError) && (
          <SettingsNotice tone="danger" role="alert">
            {switchError ?? clearError}
          </SettingsNotice>
        )}
      </SettingsGroup>
      <PreapprovalEditor
        id={BROWSER_ANCHORS.appPreapprovals}
        label="Pre-approved actions in every project"
        description="Agents skip the question for these on the shared agent profile. Payment forms always ask."
        actions={APP_PREAPPROVABLE_ACTIONS}
        entries={policy.preapprovals}
        disabled={locked}
        onAdd={({ action, origin }) => edit({ op: 'add_preapproval', action, origin })}
        onRemove={({ action, origin }) => edit({ op: 'remove_preapproval', action, origin })}
      />
      <ConfirmDialog
        isOpen={confirming}
        title="Clear agent profile"
        message={clearMessage(policy.clearImpact.sessions, policy.clearImpact.projects)}
        confirmLabel="Clear profile"
        variant="danger"
        isLoading={clearing}
        onConfirm={() => void clear()}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
