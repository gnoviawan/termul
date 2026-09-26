import { invoke } from '@tauri-apps/api/core'
import type { AgentConfig } from '@/lib/acp-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { authHeader } from '@/lib/web-auth-token'

function saveError(reason: unknown): Error {
  if (
    reason === 'OS keychain unavailable' ||
    reason === 'Could not save Factory key in OS keychain' ||
    reason === 'Could not verify Factory key in OS keychain'
  ) {
    return new Error(
      'A persistent OS secret store is unavailable. Set up macOS Keychain, Windows Credential Manager, or Linux Secret Service on the Termul host and try again.'
    )
  }
  // No arbitrary agent or backend text can be displayed: it might echo a key.
  return new Error(
    'Factory API key could not be validated or stored. Check the key and the host secret store.'
  )
}

/** The key is sent only to the host; it is never persisted in renderer storage. */
export const factoryKeyApi = {
  async status(): Promise<boolean> {
    if (isTauriContext()) {
      return invoke<boolean>('acp_factory_key_status')
    }
    const headers = authHeader()
    if (!headers?.Authorization) return false
    const response = await fetch(`${window.location.origin}/acp/factory-key`, { headers })
    if (!response.ok) return false
    const body = (await response.json()) as { configured: boolean }
    return body.configured === true
  },

  async save(config: AgentConfig, key: string): Promise<void> {
    if (!key.trim()) throw new Error('Enter a Factory API key.')
    if (isTauriContext()) {
      try {
        await invoke('acp_factory_key_save', { config, key: key.trim() })
      } catch (err) {
        throw saveError(err)
      }
      return
    }
    // Never send a credential to an unsecured or unauthenticated web host.
    if (
      window.location.protocol !== 'https:' &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1' &&
      window.location.hostname !== '[::1]'
    ) {
      throw new Error('Connect to Termul over HTTPS to send a Factory API key.')
    }
    const headers = authHeader()
    if (!headers?.Authorization) {
      throw new Error('Sign in to the Termul server before entering an API key.')
    }
    const response = await fetch(`${window.location.origin}/acp/factory-key`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ config, key: key.trim() })
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Sign in to the Termul server before entering an API key.')
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      throw saveError(body?.error)
    }
    const body = (await response.json()) as { success?: boolean }
    if (body.success === false) {
      throw saveError(undefined)
    }
  }
}
