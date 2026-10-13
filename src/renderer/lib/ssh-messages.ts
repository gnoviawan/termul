/**
 * User-facing copy for SSH connection states. Every failure says what
 * happened and what to do next; the backend detail is shown separately for
 * diagnosis.
 */
import type { SSHProfile, SSHSessionEndedEvent, SSHSessionStage } from '@shared/types/ssh.types'

type HostContext = Pick<SSHProfile, 'host' | 'port' | 'username' | 'authMethod' | 'privateKeyPath'>

export interface SSHMessage {
  title: string
  body: string
  /** The fix is in the host settings, so offer "Edit host". */
  suggestEdit: boolean
}

export function hostLabel(profile: Pick<SSHProfile, 'host' | 'port'>): string {
  if (profile.port === 22) return profile.host
  // An IPv6 literal needs brackets, or the port reads as part of the address.
  const bare = profile.host.includes(':') && !profile.host.startsWith('[')
  const host = bare ? `[${profile.host}]` : profile.host
  return `${host}:${profile.port}`
}

export function addressLabel(profile: Pick<SSHProfile, 'host' | 'port' | 'username'>): string {
  return `${profile.username}@${hostLabel(profile)}`
}

export const SSH_STAGES: SSHSessionStage[] = [
  'connecting',
  'verifyingHostKey',
  'authenticating',
  'startingShell'
]

export function stageLabel(stage: SSHSessionStage, profile: HostContext): string {
  switch (stage) {
    case 'connecting':
      return `Connect to ${hostLabel(profile)}`
    case 'verifyingHostKey':
      return 'Verify server identity'
    case 'authenticating':
      return `Sign in as ${profile.username}`
    case 'startingShell':
      return 'Open shell'
  }
}

const AUTH_METHOD_LABEL: Record<string, string> = {
  password: 'Password',
  key: 'Private key',
  agent: 'SSH agent'
}

export function authMethodLabel(method: string): string {
  return AUTH_METHOD_LABEL[method] ?? method
}

export function describeSSHError(code: string, profile: HostContext): SSHMessage {
  const host = hostLabel(profile)
  const msg = (title: string, body: string, suggestEdit = false): SSHMessage => ({
    title,
    body,
    suggestEdit
  })
  switch (code) {
    case 'SSH_INVALID_TARGET':
      return msg(
        'Host details are incomplete',
        'Check the address, port and username in the host settings.',
        true
      )
    case 'SSH_DNS_FAILED':
      return msg(
        `Can't find ${profile.host}`,
        'The address did not resolve. Check the spelling, or your network and DNS settings.',
        true
      )
    case 'SSH_CONNECTION_REFUSED':
      return msg(
        `${host} refused the connection`,
        `No SSH server is listening on port ${profile.port}. Check the port, or that the SSH service is running.`,
        true
      )
    case 'SSH_TIMEOUT':
      return msg(
        `${profile.host} didn't respond in time`,
        `The server may be offline, or a firewall may block port ${profile.port}. Check your network, then try again.`
      )
    case 'SSH_UNREACHABLE':
      return msg(
        `Can't reach ${profile.host}`,
        'The network path to the server is unavailable. Check your connection or VPN, then try again.'
      )
    case 'SSH_HANDSHAKE_FAILED':
      return msg(
        "Couldn't start a secure connection",
        `The service on ${host} did not complete the SSH handshake. Make sure this port belongs to an SSH server.`,
        true
      )
    case 'SSH_HOST_KEY_REJECTED':
      return msg(
        'Server not trusted',
        'Sign-in stopped before your credentials were sent, because the server key was not trusted. Connect again to review its key.'
      )
    case 'SSH_HOST_KEY_CHANGED':
      return msg(
        "The server's identity changed",
        'Open a terminal session to this host to review the new key before browsing files.'
      )
    case 'SSH_HOST_KEY_UNKNOWN':
      return msg(
        'Server not verified yet',
        'Open a terminal session to this host first to verify its key.'
      )
    case 'SSH_PASSWORD_REQUIRED':
      return msg('Password needed', `Enter the password for ${profile.username}.`)
    case 'SSH_PASSPHRASE_REQUIRED':
      return msg('Key passphrase needed', 'This private key is protected by a passphrase.')
    case 'SSH_PASSPHRASE_INCORRECT':
      return msg('Wrong passphrase', 'The passphrase did not unlock the private key. Try again.')
    case 'SSH_AUTH_FAILED':
      if (profile.authMethod === 'key') {
        return msg(
          'The server rejected your key',
          `Add the public key to ~/.ssh/authorized_keys for ${profile.username} on the server, or choose another key.`,
          true
        )
      }
      if (profile.authMethod === 'agent') {
        return msg(
          'No agent key was accepted',
          'Load the right key into your SSH agent (ssh-add), or choose a key file in the host settings.',
          true
        )
      }
      return msg('Wrong username or password', `Check the password for ${profile.username}.`)
    case 'SSH_AUTH_METHOD_UNAVAILABLE':
      return msg(
        "The server doesn't allow this sign-in method",
        `${authMethodLabel(profile.authMethod)} sign-in is turned off on this server. Choose another method in the host settings.`,
        true
      )
    case 'SSH_KEY_NOT_FOUND':
      return msg(
        'Private key not found',
        profile.privateKeyPath
          ? `Termul can't find ${profile.privateKeyPath}. Choose the key again in the host settings.`
          : 'Choose a private key in the host settings.',
        true
      )
    case 'SSH_KEY_INVALID':
      return msg(
        "Termul can't use this key",
        'Choose an OpenSSH or PEM private key. Convert PuTTY .ppk keys with PuTTYgen first.',
        true
      )
    case 'SSH_AGENT_UNAVAILABLE':
      return msg(
        'SSH agent not available',
        'Start your SSH agent and add a key (ssh-add), or choose a key file in the host settings.',
        true
      )
    case 'SSH_CANCELLED':
      return msg('Connection cancelled', 'Connect again when you are ready.')
    case 'SSH_SHELL_FAILED':
      return msg(
        "Signed in, but the shell didn't start",
        "The server refused a terminal session. Check the account's login shell and the server's session limits."
      )
    case 'SSH_TERMINAL_LIMIT':
      return msg('Too many terminals open', 'Close a terminal or a session tab, then try again.')
    case 'SSH_PROFILE_NOT_FOUND':
      return msg('This host was removed', 'Close this tab, or add the host again.')
    case 'WEB_UNSUPPORTED':
      return msg(
        'SSH runs in the desktop app',
        'Open Termul on your computer to connect to this host.'
      )
    default:
      return msg(
        "Couldn't connect",
        'Something went wrong while connecting. The details are below.'
      )
  }
}

export function describeSessionEnd(
  end: Pick<SSHSessionEndedEvent, 'reason' | 'exitCode' | 'detail'>,
  profile: HostContext
): SSHMessage {
  switch (end.reason) {
    case 'lost':
      return {
        title: 'Connection lost',
        body: `The connection to ${hostLabel(profile)} dropped. Output so far is kept below.`,
        suggestEdit: false
      }
    case 'exited':
      return {
        title: 'Session ended',
        body:
          end.exitCode !== null && end.exitCode !== 0
            ? `The remote shell exited with code ${end.exitCode}.`
            : 'The remote shell exited.',
        suggestEdit: false
      }
    case 'closed':
      return { title: 'Session closed', body: 'This session was closed.', suggestEdit: false }
  }
}
