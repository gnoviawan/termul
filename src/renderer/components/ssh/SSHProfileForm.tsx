import type { SSHAuthMethod, SSHProfile } from '@shared/types/ssh.types'
import { FolderOpen, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useSshTranslation } from '@/hooks/use-ssh-translation'
import { dialogApi } from '@/lib/api'
import { useSSHActions } from '@/stores/ssh-store'

interface SSHProfileFormProps {
  profile: SSHProfile | null
  onClose: () => void
  onSaved: () => void
}

export function SSHProfileForm({
  profile,
  onClose,
  onSaved
}: SSHProfileFormProps): React.JSX.Element {
  const t = useSshTranslation()
  const { saveProfile } = useSSHActions()

  const [name, setName] = useState(profile?.name ?? '')
  const [host, setHost] = useState(profile?.host ?? '')
  const [port, setPort] = useState(profile?.port ?? 22)
  const [username, setUsername] = useState(profile?.username ?? '')
  const [authMethod, setAuthMethod] = useState<SSHAuthMethod>(profile?.authMethod ?? 'key')
  const [privateKeyPath, setPrivateKeyPath] = useState(profile?.privateKeyPath ?? '')
  // Security: never hydrate credentials from stored profile - require re-entry
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSelectKeyFile = async () => {
    try {
      const result = await dialogApi.selectFile({
        title: t('profile.selectPrivateKey'),
        filters: [{ name: t('profile.allFiles'), extensions: ['*'] }]
      })
      if (result.success) {
        setPrivateKeyPath(result.data)
      } else if (result.code !== 'CANCELLED') {
        toast.error(t('profile.selectFileFailed', { error: result.error }))
      }
    } catch (error) {
      toast.error(
        t('profile.fileDialogFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!name.trim() || !host.trim() || !username.trim()) {
      toast.error(t('profile.requiredFields'))
      return
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error(t('profile.invalidPort'))
      return
    }

    setSaving(true)
    try {
      const profileData: SSHProfile = {
        id: profile?.id ?? Date.now().toString(),
        name: name.trim(),
        host: host.trim(),
        port,
        username: username.trim(),
        authMethod,
        privateKeyPath: authMethod === 'key' ? privateKeyPath.trim() || undefined : undefined,
        // Only send password/passphrase if user entered a new value
        password: authMethod === 'password' && password ? password : undefined,
        passphrase: authMethod === 'key' && passphrase ? passphrase : undefined,
        portForwards: profile?.portForwards ?? [],
        tags: profile?.tags,
        lastConnected: profile?.lastConnected,
        importedFrom: profile?.importedFrom,
        hasStoredPassword: profile?.hasStoredPassword,
        hasStoredPassphrase: profile?.hasStoredPassphrase
      }

      const success = await saveProfile(profileData)
      if (success) {
        toast.success(profile ? t('profile.updated') : t('profile.created'))
        onSaved()
      } else {
        toast.error(t('profile.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border border-border rounded-lg shadow-lg w-[420px] max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">
            {profile ? t('profile.editTitle') : t('profile.newTitle')}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('profile.name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('profile.namePlaceholder')}
              className="mt-1 w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Host + Port */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t('profile.host')}
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={t('profile.hostPlaceholder')}
                className="mt-1 w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="w-20">
              <label className="text-xs font-medium text-muted-foreground">
                {t('profile.port')}
              </label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                min={1}
                max={65535}
                className="mt-1 w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {t('profile.username')}
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('profile.usernamePlaceholder')}
              className="mt-1 w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Auth Method */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {t('profile.authentication')}
            </label>
            <select
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value as SSHAuthMethod)}
              className="mt-1 w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="key">{t('profile.auth.privateKey')}</option>
              <option value="password">{t('profile.auth.password')}</option>
              <option value="agent">{t('profile.auth.agent')}</option>
            </select>
          </div>

          {/* Private Key Path (conditional) */}
          {authMethod === 'key' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {t('profile.privateKeyPath')}
              </label>
              <div className="flex gap-2 mt-1">
                <input
                  type="text"
                  value={privateKeyPath}
                  onChange={(e) => setPrivateKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_rsa"
                  className="flex-1 px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={handleSelectKeyFile}
                  className="px-2 py-1.5 text-xs rounded border border-border bg-muted hover:bg-accent text-muted-foreground flex items-center"
                  title={t('profile.browsePrivateKey')}
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Passphrase for key (conditional) */}
          {authMethod === 'key' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {t('profile.passphrase')}
              </label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={
                  profile?.hasStoredPassphrase ? '••••••••' : t('profile.passphrasePlaceholder')
                }
                className="mt-1 w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {profile?.hasStoredPassphrase && (
                <p className="mt-1 text-3xs text-muted-foreground">
                  {t('profile.passphraseStored')}
                </p>
              )}
            </div>
          )}

          {/* Password (conditional) */}
          {authMethod === 'password' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {t('profile.password')}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  profile?.hasStoredPassword ? '••••••••' : t('profile.passwordPlaceholder')
                }
                className="mt-1 w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <p className="mt-1 text-3xs text-muted-foreground">
                {profile?.hasStoredPassword
                  ? t('profile.passwordStored')
                  : t('profile.passwordStorageHint')}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent"
            >
              {t('actions.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? t('actions.saving') : profile ? t('actions.update') : t('actions.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
