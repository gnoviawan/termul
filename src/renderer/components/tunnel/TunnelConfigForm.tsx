import { ChevronDown, ChevronUp, Info, Settings } from 'lucide-react'

interface TunnelConfigFormProps {
  name: string
  localPort: string
  hostname: string
  token: string
  disabled: boolean
  showAdvanced: boolean
  onNameChange: (value: string) => void
  onPortChange: (value: string) => void
  onHostnameChange: (value: string) => void
  onTokenChange: (value: string) => void
  onToggleAdvanced: () => void
  onSetupHelp?: () => void
}

export function TunnelConfigForm({
  name,
  localPort,
  hostname,
  token,
  disabled,
  showAdvanced,
  onNameChange,
  onPortChange,
  onHostnameChange,
  onTokenChange,
  onToggleAdvanced,
  onSetupHelp
}: TunnelConfigFormProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        <div className="flex items-center gap-2">
          <Settings size={12} />
          Configuration
        </div>
        {onSetupHelp && (
          <button
            className="p-1 rounded hover:bg-secondary text-muted-foreground transition-colors"
            title="Setup Tutorial"
            onClick={onSetupHelp}
          >
            <Info size={13} />
          </button>
        )}
      </div>

      <div className="space-y-4">
        <Field label="Tunnel Name">
          <input
            className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. My App"
            disabled={disabled}
          />
        </Field>

        <Field label="Local Port">
          <input
            className="w-full rounded border bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
            value={localPort}
            onChange={(e) => onPortChange(e.target.value)}
            placeholder="3000"
            inputMode="numeric"
            disabled={disabled}
          />
        </Field>

        <button
          onClick={onToggleAdvanced}
          className="flex items-center gap-2 text-[11px] font-bold text-primary uppercase tracking-tighter hover:underline"
        >
          {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
        </button>

        {showAdvanced && (
          <div className="space-y-4 pt-1 animate-in fade-in slide-in-from-top-1 duration-200">
            <Field label="Custom Hostname (Optional)">
              <input
                className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
                value={hostname}
                onChange={(e) => onHostnameChange(e.target.value)}
                placeholder="dev.yourdomain.com"
                disabled={disabled}
              />
            </Field>

            <Field label="Cloudflare Token (Optional)">
              <input
                type="password"
                className="w-full rounded border bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
                value={token}
                onChange={(e) => onTokenChange(e.target.value)}
                placeholder="eyJh..."
                disabled={disabled}
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-muted-foreground px-0.5">{label}</label>
      {children}
    </div>
  )
}
