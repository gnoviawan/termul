import type { SSHAuthMethod, SSHKeyFileInfo, SSHProfile } from '@shared/types/ssh.types'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Eye, EyeOff, FolderOpen } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { dialogApi, sshApi } from '@/lib/api'
import { captureFocusReturnTarget } from '@/lib/focus-return'
import {
  type HostFormErrors,
  type HostFormField,
  type HostFormValues,
  initialHostFormValues,
  splitAddress,
  toProfile,
  validateHostForm
} from '@/lib/ssh-host-form'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useSSHActions, useSSHProfiles } from '@/stores/ssh-store'

interface SSHHostEditorProps {
  open: boolean
  /** `null` creates a new host. */
  profile: SSHProfile | null
  onOpenChange: (open: boolean) => void
  /** Called after a successful save; `connect` = "Save and connect". */
  onSaved: (profile: SSHProfile, connect: boolean) => void
}

const FIELD_ORDER: HostFormField[] = ['host', 'port', 'username', 'privateKeyPath']

/** Copy for a key file that cannot be used, or `null` when it is fine. */
function keyProblem(info: SSHKeyFileInfo): string | null {
  switch (info.status) {
    case 'ok':
      return null
    case 'notFound':
      return 'No file at this path.'
    case 'unreadable':
      return 'Termul cannot read this file. Check its permissions.'
    case 'puttyFormat':
      return 'This is a PuTTY .ppk key. Convert it to OpenSSH format with PuTTYgen first.'
    case 'notPrivateKey':
      return info.path.endsWith('.pub')
        ? 'This is the public key. Choose the matching file without .pub.'
        : 'This file is not a private key.'
  }
}

function FieldError({ id, message }: { id: string; message?: string }): React.JSX.Element | null {
  if (!message) return null
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  )
}

/** Secret input with a show/hide toggle. */
function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  describedBy
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  describedBy: string
}): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        spellCheck={false}
        aria-describedby={describedBy}
        className="h-9 pr-9"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className={cn(
          'absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground',
          FOCUS_RING_CLASS
        )}
        aria-label={visible ? 'Hide' : 'Show'}
        aria-pressed={visible}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  )
}

export function SSHHostEditor({
  open,
  profile,
  onOpenChange,
  onSaved
}: SSHHostEditorProps): React.JSX.Element {
  const { saveProfile } = useSSHActions()
  const profiles = useSSHProfiles()
  const formId = useId()
  const fieldId = (name: string) => `${formId}-${name}`
  const [values, setValues] = useState<HostFormValues>(() => initialHostFormValues(profile))
  const [errors, setErrors] = useState<HostFormErrors>({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  // A port typed by hand wins over one pasted with the address.
  const [portEdited, setPortEdited] = useState(false)
  const [localKeys, setLocalKeys] = useState<SSHKeyFileInfo[]>([])
  const [keyInfo, setKeyInfo] = useState<SSHKeyFileInfo | null>(null)
  const fieldRefs = useRef<Partial<Record<HostFormField, HTMLElement | null>>>({})
  const desktop = isTauriContext()

  // Focus goes back where it was (or to the menu that opened the editor).
  const returnFocusTo = useRef<HTMLElement | null>(null)

  // Reset whenever the editor opens for a (different) host.
  useEffect(() => {
    if (!open) return
    returnFocusTo.current = captureFocusReturnTarget()
    setValues(initialHostFormValues(profile))
    setErrors({})
    setSubmitted(false)
    setKeyInfo(null)
    setPortEdited(false)
  }, [open, profile])

  // Offer keys found in ~/.ssh.
  useEffect(() => {
    if (!open || !desktop) return
    let cancelled = false
    void sshApi.listKeys().then((result) => {
      if (!cancelled && result.success) setLocalKeys(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [open, desktop])

  // Inspect the chosen key (debounced) to explain problems and passphrases.
  const keyPath = values.authMethod === 'key' ? values.privateKeyPath.trim() : ''
  useEffect(() => {
    if (!open || !desktop || !keyPath) {
      setKeyInfo(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void sshApi.inspectKey(keyPath).then((result) => {
        if (!cancelled && result.success) setKeyInfo(result.data)
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, desktop, keyPath])

  const groups = useMemo(
    () =>
      [
        ...new Set(profiles.map((p) => p.group?.trim()).filter((g): g is string => Boolean(g)))
      ].sort((a, b) => a.localeCompare(b)),
    [profiles]
  )

  const update = <K extends keyof HostFormValues>(key: K, value: HostFormValues[K]) => {
    const next = { ...values, [key]: value }
    setValues(next)
    if (submitted) setErrors(validateHostForm(next))
  }

  const handleBrowseKey = async () => {
    const result = await dialogApi.selectFile({ title: 'Choose a private key' })
    if (result.success) update('privateKeyPath', result.data)
    else if (result.code !== 'CANCELLED')
      toast.error(`Could not open the file picker: ${result.error}`)
  }

  const save = async (connect: boolean) => {
    const normalized = splitAddress(values, portEdited)
    setValues(normalized)
    setSubmitted(true)
    const nextErrors = validateHostForm(normalized)
    setErrors(nextErrors)
    const firstInvalid = FIELD_ORDER.find((field) => nextErrors[field])
    if (firstInvalid) {
      fieldRefs.current[firstInvalid]?.focus()
      return
    }
    setSaving(true)
    try {
      const next = toProfile(normalized, profile)
      const ok = await saveProfile(next)
      if (!ok) {
        toast.error('Could not save the host. Try again.')
        return
      }
      toast.success(profile ? 'Host updated' : 'Host added')
      onSaved({ ...next, password: undefined, passphrase: undefined }, connect)
    } finally {
      setSaving(false)
    }
  }

  const describe = (field: HostFormField) => (errors[field] ? fieldId(`${field}-error`) : undefined)
  const keyIssue = keyInfo ? keyProblem(keyInfo) : null
  const keyNeedsPassphrase = keyInfo?.status === 'ok' && keyInfo.encrypted
  const knownKey = localKeys.some((k) => k.path === values.privateKeyPath)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg"
        data-testid="ssh-host-editor"
        onCloseAutoFocus={(e) => {
          const target = returnFocusTo.current
          if (!target?.isConnected) return
          e.preventDefault()
          target.focus()
        }}
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base">{profile ? 'Edit host' : 'New host'}</DialogTitle>
          <DialogDescription className="text-xs">
            {profile
              ? 'Changes apply to new sessions. Open sessions keep running.'
              : 'Only the address and username are required.'}
          </DialogDescription>
        </DialogHeader>

        <form
          id={formId}
          noValidate
          className="flex-1 space-y-5 overflow-y-auto px-6 py-5"
          onSubmit={(e) => {
            e.preventDefault()
            void save(!profile && desktop)
          }}
        >
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={fieldId('host')} className="text-xs">
                Address
              </Label>
              <Input
                id={fieldId('host')}
                ref={(el) => {
                  fieldRefs.current.host = el
                }}
                value={values.host}
                onChange={(e) => update('host', e.target.value)}
                onBlur={() => setValues((prev) => splitAddress(prev, portEdited))}
                placeholder="example.com or 192.168.1.10"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                aria-invalid={Boolean(errors.host)}
                aria-describedby={describe('host')}
                className="h-9 font-mono"
              />
              <FieldError id={fieldId('host-error')} message={errors.host} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fieldId('port')} className="text-xs">
                Port
              </Label>
              <Input
                id={fieldId('port')}
                ref={(el) => {
                  fieldRefs.current.port = el
                }}
                value={values.port}
                onChange={(e) => {
                  setPortEdited(true)
                  update('port', e.target.value)
                }}
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={Boolean(errors.port)}
                aria-describedby={describe('port')}
                className="h-9 font-mono tabular-nums"
              />
              <FieldError id={fieldId('port-error')} message={errors.port} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={fieldId('username')} className="text-xs">
              Username
            </Label>
            <Input
              id={fieldId('username')}
              ref={(el) => {
                fieldRefs.current.username = el
              }}
              value={values.username}
              onChange={(e) => update('username', e.target.value)}
              placeholder="root"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(errors.username)}
              aria-describedby={describe('username')}
              className="h-9 font-mono"
            />
            <FieldError id={fieldId('username-error')} message={errors.username} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={fieldId('auth')} className="text-xs">
              Authentication
            </Label>
            <Select
              value={values.authMethod}
              onValueChange={(v) => update('authMethod', v as SSHAuthMethod)}
            >
              <SelectTrigger id={fieldId('auth')} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="password">Password</SelectItem>
                <SelectItem value="key">Private key</SelectItem>
                <SelectItem value="agent">SSH agent</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {values.authMethod === 'password' && (
            <div className="space-y-1.5">
              <Label htmlFor={fieldId('password')} className="text-xs">
                Password
              </Label>
              <SecretInput
                id={fieldId('password')}
                value={values.password}
                onChange={(v) => update('password', v)}
                placeholder={profile?.hasStoredPassword ? 'Saved — type to replace' : 'Optional'}
                describedBy={fieldId('password-help')}
              />
              <p id={fieldId('password-help')} className="text-xs text-muted-foreground">
                {profile?.hasStoredPassword
                  ? 'Saved in your system keychain. Leave empty to keep it.'
                  : 'Saved in your system keychain. Leave empty to be asked when you connect.'}
              </p>
            </div>
          )}

          {values.authMethod === 'key' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={fieldId('key')} className="text-xs">
                  Private key
                </Label>
                {localKeys.length > 0 && (
                  <Select
                    value={knownKey ? values.privateKeyPath : ''}
                    onValueChange={(v) => update('privateKeyPath', v)}
                  >
                    <SelectTrigger className="h-9" aria-label="Keys found in ~/.ssh">
                      <SelectValue placeholder="Choose a key from ~/.ssh" />
                    </SelectTrigger>
                    <SelectContent>
                      {localKeys.map((key) => (
                        <SelectItem key={key.path} value={key.path}>
                          {key.path.split(/[\\/]/).pop()}
                          {key.keyType ? ` · ${key.keyType}` : ''}
                          {key.encrypted ? ' · passphrase' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <div className="flex gap-2">
                  <Input
                    id={fieldId('key')}
                    ref={(el) => {
                      fieldRefs.current.privateKeyPath = el
                    }}
                    value={values.privateKeyPath}
                    onChange={(e) => update('privateKeyPath', e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(errors.privateKeyPath || keyIssue)}
                    aria-describedby={fieldId('key-help')}
                    className="h-9 flex-1 font-mono text-xs md:text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9"
                    onClick={() => void handleBrowseKey()}
                    disabled={!desktop}
                  >
                    <FolderOpen />
                    Browse
                  </Button>
                </div>
                <div id={fieldId('key-help')}>
                  {errors.privateKeyPath ? (
                    <p className="text-xs text-destructive">{errors.privateKeyPath}</p>
                  ) : keyIssue ? (
                    <p className="text-xs text-destructive">{keyIssue}</p>
                  ) : keyInfo?.status === 'ok' ? (
                    <p className="text-xs text-muted-foreground">
                      {keyInfo.keyType ?? 'Private key'}
                      {keyInfo.encrypted ? ', protected by a passphrase.' : ', no passphrase.'}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      OpenSSH or PEM format. The key stays where it is.
                    </p>
                  )}
                </div>
              </div>

              {(keyNeedsPassphrase || profile?.hasStoredPassphrase) && (
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId('passphrase')} className="text-xs">
                    Key passphrase
                  </Label>
                  <SecretInput
                    id={fieldId('passphrase')}
                    value={values.passphrase}
                    onChange={(v) => update('passphrase', v)}
                    placeholder={
                      profile?.hasStoredPassphrase ? 'Saved — type to replace' : 'Optional'
                    }
                    describedBy={fieldId('passphrase-help')}
                  />
                  <p id={fieldId('passphrase-help')} className="text-xs text-muted-foreground">
                    {profile?.hasStoredPassphrase
                      ? 'Saved in your system keychain. Leave empty to keep it.'
                      : 'Saved in your system keychain. Leave empty to be asked when you connect.'}
                  </p>
                </div>
              )}
            </>
          )}

          {values.authMethod === 'agent' && (
            <p className="text-xs text-muted-foreground">
              Uses the keys loaded in your SSH agent (ssh-agent, Pageant or the Windows OpenSSH
              agent). Nothing secret is stored by Termul.
            </p>
          )}

          <div className="space-y-4 border-t border-border pt-5">
            <div className="space-y-1.5">
              <Label htmlFor={fieldId('name')} className="text-xs">
                Label
              </Label>
              <Input
                id={fieldId('name')}
                value={values.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder={values.host.trim() || 'Production web'}
                autoComplete="off"
                aria-describedby={fieldId('name-help')}
                className="h-9"
              />
              <p id={fieldId('name-help')} className="text-xs text-muted-foreground">
                Shown in the host list and on session tabs. Defaults to the address.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={fieldId('group')} className="text-xs">
                  Group
                </Label>
                <Input
                  id={fieldId('group')}
                  value={values.group}
                  onChange={(e) => update('group', e.target.value)}
                  list={fieldId('groups')}
                  placeholder="None"
                  autoComplete="off"
                  className="h-9"
                />
                <datalist id={fieldId('groups')}>
                  {groups.map((group) => (
                    <option key={group} value={group} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={fieldId('tags')} className="text-xs">
                  Tags
                </Label>
                <Input
                  id={fieldId('tags')}
                  value={values.tags}
                  onChange={(e) => update('tags', e.target.value)}
                  placeholder="prod, web"
                  autoComplete="off"
                  aria-describedby={fieldId('tags-help')}
                  className="h-9"
                />
                <p id={fieldId('tags-help')} className="sr-only">
                  Separate tags with commas.
                </p>
              </div>
            </div>
          </div>
        </form>

        <DialogFooter className="gap-2 border-t border-border px-6 py-3 sm:space-x-0">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {profile ? (
            <Button type="submit" form={formId} size="sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => void save(false)}
              >
                Save
              </Button>
              <Button type="submit" form={formId} size="sm" disabled={saving}>
                {saving ? 'Saving…' : desktop ? 'Save and connect' : 'Save'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
