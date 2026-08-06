import { ExternalLink, FolderOpen, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { type AcpBinaryVerification, acpApi } from '@/lib/acp-api'
import { currentPlatformArch } from '@/lib/agents/acp-registry'
import {
  ANTIGRAVITY_ACP_RELEASE,
  ANTIGRAVITY_ACP_RELEASE_URL,
  ANTIGRAVITY_ACP_REPOSITORY_URL,
  ANTIGRAVITY_ACP_TERMS_URL,
  getAntigravityAcpReleaseTarget
} from '@/lib/agents/antigravity-acp'
import {
  hasAntigravityAcpAcknowledgement,
  saveAntigravityAcpAcknowledgement
} from '@/lib/agents/antigravity-acp-consent'
import { manualBinaryConfig, type SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { dialogApi, openerApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'

interface AntigravityAcpSetupPanelProps {
  entry: SupportedAcpAgentEntry
  onConfigured?: (config: StoredAgentConfig) => void | Promise<void>
  onAcknowledgementChange?: (acknowledged: boolean) => void
}

export function AntigravityAcpSetupPanel({
  entry,
  onConfigured,
  onAcknowledgementChange
}: AntigravityAcpSetupPanelProps): React.JSX.Element {
  const saveAgentConfig = useAcpStore((state) => state.saveAgentConfig)
  const deleteAgentConfig = useAcpStore((state) => state.deleteAgentConfig)
  const platformArch = useMemo(() => currentPlatformArch(), [])
  const target = getAntigravityAcpReleaseTarget(platformArch)
  const desktop = isTauriContext()
  const [path, setPath] = useState(entry.config?.command ?? '')
  const [acknowledged, setAcknowledged] = useState(false)
  const [riskChecked, setRiskChecked] = useState(false)
  const [checksumConfirmed, setChecksumConfirmed] = useState(false)
  const [loadingAcknowledgement, setLoadingAcknowledgement] = useState(true)
  const [saving, setSaving] = useState(false)
  const [verification, setVerification] = useState<AcpBinaryVerification | null>(null)

  useEffect(() => {
    setPath(entry.config?.command ?? '')
    setChecksumConfirmed(false)
    setVerification(null)
  }, [entry.config?.command])

  useEffect(() => {
    let cancelled = false
    setLoadingAcknowledgement(true)
    void hasAntigravityAcpAcknowledgement()
      .then((value) => {
        if (cancelled) return
        setAcknowledged(value)
        setRiskChecked(value)
        onAcknowledgementChange?.(value)
      })
      .finally(() => {
        if (!cancelled) setLoadingAcknowledgement(false)
      })
    return () => {
      cancelled = true
    }
  }, [onAcknowledgementChange])

  const handleBrowse = (): void => {
    void dialogApi
      .selectFile({
        title: 'Select Antigravity ACP executable',
        filters: platformArch.startsWith('windows-')
          ? [{ name: 'Executable', extensions: ['exe'] }]
          : undefined
      })
      .then((result) => {
        if (result.success && result.data) {
          setPath(result.data)
          setChecksumConfirmed(false)
          setVerification(null)
        }
      })
  }

  const handleSave = (): void => {
    void (async () => {
      const command = path.trim()
      if (!target) {
        toast.error('Antigravity does not publish a binary for this platform.')
        return
      }
      if (!command) {
        toast.error('Enter the path to the Antigravity ACP binary.')
        return
      }
      if (!acknowledged && !riskChecked) {
        toast.error('Acknowledge the Antigravity account risk before saving.')
        return
      }
      if (!desktop && !checksumConfirmed) {
        toast.error('Confirm the downloaded binary checksum before saving.')
        return
      }

      setSaving(true)
      try {
        if (desktop) {
          const result = await acpApi.verifyBinary(command, target.sha256)
          setVerification(result)
          if (!result.matches) {
            void logFrontendError({
              level: 'warn',
              source: 'acp.antigravity.checksum',
              message: `Checksum mismatch for ${target.fileName}`
            })
            toast.error(
              `Checksum mismatch. Expected ${target.sha256.slice(0, 12)}…, got ${result.actualSha256.slice(0, 12)}….`
            )
            return
          }
        }

        if (!acknowledged) {
          await saveAntigravityAcpAcknowledgement()
          setAcknowledged(true)
          onAcknowledgementChange?.(true)
        }

        const config = manualBinaryConfig(entry.agent, command, {
          cmd: target.fileName,
          args: [],
          env: {}
        })
        await saveAgentConfig(config)
        await onConfigured?.(config)
        toast.success(`${entry.agent.name} configured`)
      } catch (error) {
        void logFrontendError({
          level: 'error',
          source: 'acp.antigravity.setup',
          message: String(error)
        })
        toast.error(`Failed to configure ${entry.agent.name}: ${String(error)}`)
      } finally {
        setSaving(false)
      }
    })()
  }

  const handleClear = (): void => {
    if (!entry.config || saving) return
    setSaving(true)
    void deleteAgentConfig(entry.configId)
      .then(() => {
        setPath('')
        setChecksumConfirmed(false)
        setVerification(null)
        toast.success(`${entry.agent.name} path cleared`)
      })
      .catch((error) => {
        void logFrontendError({
          level: 'error',
          source: 'acp.antigravity.clear',
          message: String(error)
        })
        toast.error(`Failed to clear ${entry.agent.name}: ${String(error)}`)
      })
      .finally(() => setSaving(false))
  }

  const riskAcknowledged = acknowledged || riskChecked
  const saveDisabled =
    saving ||
    loadingAcknowledgement ||
    !target ||
    path.trim().length === 0 ||
    !riskAcknowledged ||
    (!desktop && !checksumConfirmed)

  return (
    <div className="mt-2 space-y-3 rounded-md border border-amber-500/30 bg-amber-500/[0.04] p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {entry.config ? 'Antigravity setup' : 'Manual setup'}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Download the pinned v{ANTIGRAVITY_ACP_RELEASE} binary, then select its local path. The
          bridge can download the separate <code>agy</code> cli on first launch.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            onClick={() =>
              void openerApi.openUrlWithSystemBrowser(
                target?.downloadUrl ?? ANTIGRAVITY_ACP_RELEASE_URL
              )
            }
          >
            Download {target?.fileName ?? 'release'}
            <ExternalLink size={11} />
          </button>
          <button
            type="button"
            className="text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => void openerApi.openUrlWithSystemBrowser(ANTIGRAVITY_ACP_REPOSITORY_URL)}
          >
            Upstream project
          </button>
        </div>
        {target && (
          <p className="break-all font-mono text-2xs text-muted-foreground">
            sha-256: {target.sha256}
          </p>
        )}
      </div>

      <div className="space-y-2 rounded border border-amber-500/25 bg-background/50 p-2.5">
        <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          The upstream project warns that using a third-party tool with personal Antigravity OAuth
          may violate Google terms and may cause account suspension.
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
            onClick={() => void openerApi.openUrlWithSystemBrowser(ANTIGRAVITY_ACP_REPOSITORY_URL)}
          >
            Read the upstream warning
            <ExternalLink size={11} />
          </button>
          <button
            type="button"
            className="text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
            onClick={() => void openerApi.openUrlWithSystemBrowser(ANTIGRAVITY_ACP_TERMS_URL)}
          >
            Read Google terms
          </button>
        </div>
        <label className="flex items-start gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={riskAcknowledged}
            disabled={acknowledged || loadingAcknowledgement || saving}
            onChange={(event) => setRiskChecked(event.target.checked)}
            className="mt-0.5 size-3.5 accent-foreground"
          />
          <span>I understand this account risk.</span>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={path}
          onChange={(event) => {
            setPath(event.target.value)
            setChecksumConfirmed(false)
            setVerification(null)
          }}
          placeholder="Path to agy-acp binary"
          aria-label="Antigravity ACP executable path"
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          disabled={saving}
        />
        {desktop && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={handleBrowse}
            aria-label="Browse for Antigravity ACP executable"
          >
            <FolderOpen size={14} />
          </Button>
        )}
        <Button type="button" size="sm" disabled={saveDisabled} onClick={handleSave}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </Button>
      </div>

      {!desktop && (
        <label className="flex items-start gap-2 text-2xs text-muted-foreground">
          <input
            type="checkbox"
            checked={checksumConfirmed}
            disabled={saving || !target}
            onChange={(event) => setChecksumConfirmed(event.target.checked)}
            className="mt-0.5 size-3.5 accent-foreground"
          />
          <span>I verified that the server binary matches the sha-256 value above.</span>
        </label>
      )}

      {verification && !verification.matches && (
        <p className="break-all text-2xs text-destructive">
          Actual sha-256: {verification.actualSha256}
        </p>
      )}

      {entry.config && (
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={handleClear}>
          Clear saved path
        </Button>
      )}
    </div>
  )
}
