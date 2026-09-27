import type { ClaudeAuthStatus } from '@shared/types/claude-agent.types'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { KeyRound, Loader2, ShieldCheck } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { claudeAgentApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { terminalApi } from '@/lib/terminal-api'
import { openTerminalAtCwd } from '@/lib/terminal-spawn'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'

export function ClaudeAgentSettings(): React.JSX.Element | null {
  const desktop = isTauriContext()
  const [status, setStatus] = useState<ClaudeAuthStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const project = useProjectStore((state) =>
    state.projects.find((item) => item.id === state.activeProjectId)
  )

  const refresh = useCallback(async () => {
    const result = await claudeAgentApi.setupStatus()
    if (result.success && result.data) {
      setStatus(result.data)
      setError(null)
    } else {
      const message =
        'error' in result && result.error
          ? result.error
          : 'Claude authentication settings are unavailable.'
      setError(message)
      void logFrontendError({
        level: 'error',
        source: 'ClaudeAgentSettings.setupStatus',
        message: 'Could not read Claude host authentication status.'
      })
    }
  }, [])

  useEffect(() => {
    if (desktop) void refresh()
  }, [desktop, refresh])

  const updateMode = async (mode: 'claude-code' | 'api-key'): Promise<boolean> => {
    const result = await claudeAgentApi.setAuthMode(mode)
    if (!result.success) {
      toast.error(result.error ?? 'Could not save Claude authentication preference.')
      return false
    }
    await refresh()
    return true
  }

  const saveApiKey = async (): Promise<void> => {
    if (!apiKey.trim()) {
      toast.error('Enter a Claude API key.')
      return
    }
    setLoading(true)
    try {
      const saved = await claudeAgentApi.saveApiKey(apiKey)
      if (!saved.success) {
        toast.error(saved.error ?? 'Could not save Claude API key in the OS keychain.')
        return
      }
      setApiKey('')
      if (await updateMode('api-key')) {
        toast.success('Claude API key saved in the OS keychain.')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleClaudeCodeLogin = async (): Promise<void> => {
    if (await updateMode('claude-code')) toast.success('Claude Code login selected.')
  }

  const startCliLogin = async (): Promise<void> => {
    if (!project?.path) {
      toast.error('Select a project before opening the sign-in terminal.')
      return
    }
    const opened = await openTerminalAtCwd(project.id, project.path)
    if (opened.status !== 'opened' || !opened.terminalId) {
      toast.error(
        opened.status === 'spawn-failed'
          ? (opened.error ?? 'Could not open a terminal.')
          : 'Open a workspace pane before starting Claude sign-in.'
      )
      return
    }
    const terminal = useTerminalStore
      .getState()
      .terminals.find((item) => item.id === opened.terminalId)
    if (!terminal?.ptyId) {
      toast.error('The sign-in terminal did not start correctly.')
      return
    }
    const result = await terminalApi.write(terminal.ptyId, 'claude auth login\r')
    if (!result.success) {
      toast.error(result.error ?? 'Could not start Claude CLI sign-in.')
      return
    }
    toast.success('Claude CLI sign-in started in the new terminal.')
  }

  const handleSavedApiKey = async (): Promise<void> => {
    if (status?.apiKeyConfigured && (await updateMode('api-key'))) {
      toast.success('Saved Claude API key selected.')
    }
  }

  const removeApiKey = async (): Promise<void> => {
    setLoading(true)
    try {
      if (status?.authMode === 'api-key' && !(await updateMode('claude-code'))) return
      const result = await claudeAgentApi.deleteApiKey()
      if (!result.success) {
        toast.error(result.error ?? 'Could not remove Claude API key from the OS keychain.')
        return
      }
      await refresh()
      toast.success('Claude API key removed.')
    } finally {
      setLoading(false)
    }
  }

  if (!desktop) return null

  return (
    <section className="space-y-3 rounded-md border border-border/60 p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck size={15} className="mt-0.5 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-medium">Claude Agent authentication</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Host-wide setting. Connected remote clients can use this host credential but cannot
            change it.
          </p>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={status?.authMode === 'claude-code' ? 'default' : 'outline'}
              disabled={loading || !status}
              onClick={() => void handleClaudeCodeLogin()}
            >
              Use Claude Code login
            </Button>
            {status?.apiKeyConfigured && (
              <Button
                type="button"
                size="sm"
                variant={status.authMode === 'api-key' ? 'default' : 'outline'}
                disabled={loading}
                onClick={() => void handleSavedApiKey()}
              >
                Use saved API key
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {status?.cliInstalled
              ? status.cliAuthenticated === true
                ? 'Claude Code CLI is installed and signed in.'
                : status.cliAuthenticated === false
                  ? 'Claude Code CLI is installed but not signed in.'
                  : 'Claude Code CLI is installed; sign-in status could not be checked.'
              : 'Claude Code CLI is not installed. Install it from Anthropic, then run `claude auth login` in a terminal.'}
          </p>

          {status?.authMode === 'claude-code' && !status.cliAuthenticated && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-muted-foreground">
                {status.cliInstalled
                  ? 'Sign in with the existing Claude Code CLI account.'
                  : 'Install Claude Code CLI from Anthropic before signing in.'}
              </p>
              {status.cliInstalled && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void startCliLogin()}
                >
                  Run claude auth login
                </Button>
              )}
            </div>
          )}

          <div className="space-y-2 border-t border-border/60 pt-3">
            <label
              htmlFor="claude-api-key"
              className="flex items-center gap-1.5 text-xs font-medium"
            >
              <KeyRound size={13} />
              API key (optional)
            </label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="claude-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                placeholder="Paste Anthropic API key"
                className="h-8 min-w-48 flex-1 font-mono text-xs"
                disabled={loading}
              />
              <Button
                type="button"
                size="sm"
                disabled={loading || !apiKey.trim()}
                onClick={() => void saveApiKey()}
              >
                {loading && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                Save and use
              </Button>
              {status?.apiKeyConfigured && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={loading}
                  onClick={() => void removeApiKey()}
                >
                  Remove key
                </Button>
              )}
            </div>
            <p className="text-2xs text-muted-foreground">
              Stored only in the host OS keychain. Termul never displays or returns the saved key.
            </p>
          </div>
        </>
      )}
    </section>
  )
}
