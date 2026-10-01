import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { factoryKeyApi } from '@/lib/factory-key-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'

/** State + actions for the Factory inline API-key auth flow (see AgentAuthPolicy.inlineKeyFormMethodId). */
export interface FactoryKeyAuth {
  /** The inline key form is showing. */
  showKeyInput: boolean
  /** A key save/validation round-trip is in flight. */
  saving: boolean
  value: string
  setValue: (value: string) => void
  /** Show the inline key form (the auth-policy-gated method was chosen). */
  requestKeyInput: () => void
  /** Discard the draft and hide the form. */
  cancel: () => void
  /** Validate + store the key on the host, then detach + re-prepare the chat. */
  save: () => Promise<void>
}

/**
 * The Factory API-key auth flow for the launcher: inline key input, save to
 * the host (`factoryKeyApi` — the key never goes through the agent), then
 * detach live sessions and re-prepare so the new credentials take effect.
 */
export function useFactoryKeyAuth(
  selectedConfig: StoredAgentConfig | null,
  projectRoot: string | undefined,
  onRetry: () => void
): FactoryKeyAuth {
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const activeConfigId = selectedConfig?.id ?? ''

  const save = useCallback(async () => {
    if (!selectedConfig || !projectRoot || !value.trim() || saving) return
    setSaving(true)
    try {
      await factoryKeyApi.save(selectedConfig, value)
      setValue('')
      setShowKeyInput(false)
      useAcpStore.getState().detachAgentForNewCredentials(activeConfigId, projectRoot)
      onRetry()
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'AgentLauncher.handleSaveFactoryKey',
        message: 'Factory key validation or storage failed'
      })
      toast.error(err instanceof Error ? err.message : 'Factory API key could not be stored.')
    } finally {
      setSaving(false)
    }
  }, [selectedConfig, projectRoot, value, saving, activeConfigId, onRetry])

  const cancel = useCallback(() => {
    setValue('')
    setShowKeyInput(false)
  }, [])

  const requestKeyInput = useCallback(() => setShowKeyInput(true), [])

  return { showKeyInput, saving, value, setValue, requestKeyInput, cancel, save }
}

/** The inline Factory API-key form rendered under the auth banner. */
export function FactoryApiKeyForm({ auth }: { auth: FactoryKeyAuth }): React.JSX.Element {
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-b border-border/60 px-5 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        void auth.save()
      }}
    >
      <label htmlFor="factory-api-key-input" className="min-w-48 flex-1 text-xs">
        Factory API key
        <Input
          id="factory-api-key-input"
          type="password"
          value={auth.value}
          onChange={(event) => auth.setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="mt-1"
          disabled={auth.saving}
        />
      </label>
      <Button type="submit" size="sm" disabled={!auth.value.trim() || auth.saving}>
        {auth.saving ? 'Validating…' : 'Save and connect'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={auth.saving}
        onClick={auth.cancel}
      >
        Cancel
      </Button>
    </form>
  )
}
