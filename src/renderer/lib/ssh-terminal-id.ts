/** Real project ids are UUIDs, so this prefix never collides with one. */
const SSH_TERMINAL_PREFIX = 'ssh-'

/** Terminal-store project bucket for a host's session terminals. */
export function sshTerminalProjectId(profileId: string): string {
  return `${SSH_TERMINAL_PREFIX}${profileId}`
}

export function isSSHTerminalProjectId(projectId: string): boolean {
  return projectId.startsWith(SSH_TERMINAL_PREFIX)
}
