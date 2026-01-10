import { existsSync as fsExistsSync } from 'node:fs'

export interface ShellInfo {
  path: string
  name: string
  displayName: string
}

export interface DetectedShells {
  default: ShellInfo | null
  available: ShellInfo[]
}

const WINDOWS_SHELLS: Array<{ path: string; name: string; displayName: string }> = [
  { path: 'powershell.exe', name: 'powershell', displayName: 'PowerShell' },
  { path: 'pwsh.exe', name: 'pwsh', displayName: 'PowerShell Core' },
  { path: 'cmd.exe', name: 'cmd', displayName: 'Command Prompt' },
  { path: 'C:\\Program Files\\Git\\bin\\bash.exe', name: 'git-bash', displayName: 'Git Bash' },
  { path: 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', name: 'git-bash', displayName: 'Git Bash' },
  { path: 'wsl.exe', name: 'wsl', displayName: 'WSL' }
]

const UNIX_SHELLS: Array<{ path: string; name: string; displayName: string }> = [
  { path: '/bin/bash', name: 'bash', displayName: 'Bash' },
  { path: '/bin/zsh', name: 'zsh', displayName: 'Zsh' },
  { path: '/usr/bin/zsh', name: 'zsh', displayName: 'Zsh' },
  { path: '/bin/fish', name: 'fish', displayName: 'Fish' },
  { path: '/usr/bin/fish', name: 'fish', displayName: 'Fish' },
  { path: '/bin/sh', name: 'sh', displayName: 'Bourne Shell' }
]

export let _checkFileExists: (path: string) => boolean = fsExistsSync

export function _setFileExistsCheck(fn: (path: string) => boolean): void {
  _checkFileExists = fn
}

export function _resetFileExistsCheck(): void {
  _checkFileExists = fsExistsSync
}

export function getCurrentPlatform(): NodeJS.Platform {
  return process.platform
}

export function getDefaultShell(): ShellInfo | null {
  const currentPlatform = getCurrentPlatform()

  if (currentPlatform === 'win32') {
    const comspec = process.env.COMSPEC || 'cmd.exe'
    const shellName = comspec.toLowerCase().includes('powershell') ? 'powershell' : 'cmd'
    return {
      path: comspec,
      name: shellName,
      displayName: shellName === 'powershell' ? 'PowerShell' : 'Command Prompt'
    }
  }

  const shell = process.env.SHELL
  if (shell) {
    const name = shell.split('/').pop() || 'sh'
    return {
      path: shell,
      name,
      displayName: name.charAt(0).toUpperCase() + name.slice(1)
    }
  }

  return { path: '/bin/sh', name: 'sh', displayName: 'Bourne Shell' }
}

export function detectAvailableShells(): ShellInfo[] {
  const currentPlatform = getCurrentPlatform()
  const shells: ShellInfo[] = []
  const candidates = currentPlatform === 'win32' ? WINDOWS_SHELLS : UNIX_SHELLS

  for (const candidate of candidates) {
    if (isShellAvailable(candidate.path, currentPlatform)) {
      const existingIndex = shells.findIndex((s) => s.name === candidate.name)
      if (existingIndex === -1) {
        shells.push({
          path: candidate.path,
          name: candidate.name,
          displayName: candidate.displayName
        })
      }
    }
  }

  return shells
}

function isShellAvailable(shellPath: string, currentPlatform: NodeJS.Platform): boolean {
  if (currentPlatform === 'win32') {
    if (shellPath.includes('\\') || shellPath.includes('/')) {
      return _checkFileExists(shellPath)
    }
    return true
  }

  return _checkFileExists(shellPath)
}

export function detectShells(): DetectedShells {
  return {
    default: getDefaultShell(),
    available: detectAvailableShells()
  }
}

export function getShellByName(name: string): ShellInfo | null {
  const shells = detectAvailableShells()
  return shells.find((s) => s.name === name) || null
}

export function getHomeDirectory(): string {
  if (getCurrentPlatform() === 'win32') {
    return process.env.USERPROFILE || process.env.HOME || 'C:\\'
  }
  return process.env.HOME || '/tmp'
}
