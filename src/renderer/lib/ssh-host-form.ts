/** Pure helpers behind the SSH host editor (validation and parsing). */
import type { SSHAuthMethod, SSHProfile } from '@shared/types/ssh.types'
import { randomUUID } from '@/lib/uuid'

export interface HostFormValues {
  name: string
  host: string
  /** Text as typed, validated on save */
  port: string
  username: string
  authMethod: SSHAuthMethod
  privateKeyPath: string
  /** New password; empty keeps the stored one */
  password: string
  /** New key passphrase; empty keeps the stored one */
  passphrase: string
  group: string
  /** Comma-separated */
  tags: string
}

export type HostFormField = 'host' | 'port' | 'username' | 'privateKeyPath'
export type HostFormErrors = Partial<Record<HostFormField, string>>

export function initialHostFormValues(profile: SSHProfile | null): HostFormValues {
  return {
    name: profile?.name ?? '',
    host: profile?.host ?? '',
    port: String(profile?.port ?? 22),
    username: profile?.username ?? '',
    authMethod: profile?.authMethod ?? 'password',
    privateKeyPath: profile?.privateKeyPath ?? '',
    // Secrets are never read back into the form.
    password: '',
    passphrase: '',
    group: profile?.group ?? '',
    tags: (profile?.tags ?? []).join(', ')
  }
}

export function parsePort(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const port = Number(trimmed)
  return port >= 1 && port <= 65535 ? port : null
}

export function validateHostForm(values: HostFormValues): HostFormErrors {
  const errors: HostFormErrors = {}
  const host = values.host.trim()
  if (!host) errors.host = 'Enter a hostname or IP address.'
  else if (/\s/.test(host)) errors.host = 'The address cannot contain spaces.'
  if (parsePort(values.port) === null) errors.port = 'Use a port from 1 to 65535.'
  if (!values.username.trim()) errors.username = 'Enter the username to sign in with.'
  else if (/\s/.test(values.username.trim()))
    errors.username = 'The username cannot contain spaces.'
  if (values.authMethod === 'key' && !values.privateKeyPath.trim()) {
    errors.privateKeyPath = 'Choose a private key file.'
  }
  return errors
}

/**
 * Split a pasted `user@host:port` into its parts. Only fills the username
 * and port when they were not typed separately; IPv6 literals (several
 * colons) keep their colons.
 */
export function splitAddress(values: HostFormValues): HostFormValues {
  let host = values.host.trim()
  let username = values.username
  let port = values.port
  const at = host.lastIndexOf('@')
  if (at > 0) {
    if (!username.trim()) username = host.slice(0, at)
    host = host.slice(at + 1)
  }
  const portMatch = /^([^:[\]]+):(\d{1,5})$/.exec(host) ?? /^\[([^\]]+)\]:(\d{1,5})$/.exec(host)
  if (portMatch) {
    host = portMatch[1]
    port = portMatch[2]
  }
  return { ...values, host, username, port }
}

export function parseTags(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(',')) {
    const tag = raw.trim()
    if (tag) seen.add(tag)
  }
  return [...seen]
}

/** Build the profile to save; secrets are only sent when newly typed. */
export function toProfile(values: HostFormValues, existing: SSHProfile | null): SSHProfile {
  const host = values.host.trim()
  const tags = parseTags(values.tags)
  return {
    ...(existing ?? { portForwards: [] }),
    id: existing?.id ?? randomUUID(),
    name: values.name.trim() || host,
    host,
    port: parsePort(values.port) ?? 22,
    username: values.username.trim(),
    authMethod: values.authMethod,
    privateKeyPath: values.authMethod === 'key' ? values.privateKeyPath.trim() : undefined,
    password: values.authMethod === 'password' && values.password ? values.password : undefined,
    passphrase: values.authMethod === 'key' && values.passphrase ? values.passphrase : undefined,
    group: values.group.trim() || undefined,
    tags: tags.length > 0 ? tags : undefined,
    portForwards: existing?.portForwards ?? []
  }
}
