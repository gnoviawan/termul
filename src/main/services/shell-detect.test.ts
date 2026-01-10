import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as shellDetect from './shell-detect'

describe('shell-detect', () => {
  const originalEnv = process.env
  const originalPlatform = process.platform

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    shellDetect._resetFileExistsCheck()
  })

  function mockPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, writable: true })
  }

  function mockFileExists(fn: (path: string) => boolean): void {
    shellDetect._setFileExistsCheck(fn)
  }

  describe('getCurrentPlatform', () => {
    it('should return the current platform', () => {
      const result = shellDetect.getCurrentPlatform()
      expect(result).toBe(process.platform)
    })
  })

  describe('getDefaultShell', () => {
    it('should return PowerShell on Windows when COMSPEC contains powershell', () => {
      mockPlatform('win32')
      process.env.COMSPEC = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

      const result = shellDetect.getDefaultShell()

      expect(result).toEqual({
        path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        name: 'powershell',
        displayName: 'PowerShell'
      })
    })

    it('should return Command Prompt on Windows when COMSPEC is cmd', () => {
      mockPlatform('win32')
      process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'

      const result = shellDetect.getDefaultShell()

      expect(result).toEqual({
        path: 'C:\\Windows\\System32\\cmd.exe',
        name: 'cmd',
        displayName: 'Command Prompt'
      })
    })

    it('should default to cmd.exe on Windows when COMSPEC is not set', () => {
      mockPlatform('win32')
      delete process.env.COMSPEC

      const result = shellDetect.getDefaultShell()

      expect(result).toEqual({
        path: 'cmd.exe',
        name: 'cmd',
        displayName: 'Command Prompt'
      })
    })

    it('should return SHELL environment variable on Unix', () => {
      mockPlatform('linux')
      process.env.SHELL = '/bin/zsh'

      const result = shellDetect.getDefaultShell()

      expect(result).toEqual({
        path: '/bin/zsh',
        name: 'zsh',
        displayName: 'Zsh'
      })
    })

    it('should return /bin/sh on Unix when SHELL is not set', () => {
      mockPlatform('linux')
      delete process.env.SHELL

      const result = shellDetect.getDefaultShell()

      expect(result).toEqual({
        path: '/bin/sh',
        name: 'sh',
        displayName: 'Bourne Shell'
      })
    })
  })

  describe('detectAvailableShells', () => {
    it('should detect available Windows shells', () => {
      mockPlatform('win32')
      mockFileExists((path: string) => {
        return path === 'C:\\Program Files\\Git\\bin\\bash.exe'
      })

      const shells = shellDetect.detectAvailableShells()

      expect(shells).toContainEqual({
        path: 'powershell.exe',
        name: 'powershell',
        displayName: 'PowerShell'
      })
      expect(shells).toContainEqual({
        path: 'cmd.exe',
        name: 'cmd',
        displayName: 'Command Prompt'
      })
      expect(shells).toContainEqual({
        path: 'C:\\Program Files\\Git\\bin\\bash.exe',
        name: 'git-bash',
        displayName: 'Git Bash'
      })
    })

    it('should detect available Unix shells', () => {
      mockPlatform('linux')
      mockFileExists((path: string) => {
        return path === '/bin/bash' || path === '/bin/zsh' || path === '/bin/sh'
      })

      const shells = shellDetect.detectAvailableShells()

      expect(shells).toContainEqual({
        path: '/bin/bash',
        name: 'bash',
        displayName: 'Bash'
      })
      expect(shells).toContainEqual({
        path: '/bin/zsh',
        name: 'zsh',
        displayName: 'Zsh'
      })
      expect(shells).toContainEqual({
        path: '/bin/sh',
        name: 'sh',
        displayName: 'Bourne Shell'
      })
    })

    it('should not include duplicate shells with same name', () => {
      mockPlatform('linux')
      mockFileExists((path: string) => {
        return path === '/bin/zsh' || path === '/usr/bin/zsh'
      })

      const shells = shellDetect.detectAvailableShells()

      const zshShells = shells.filter((s) => s.name === 'zsh')
      expect(zshShells).toHaveLength(1)
      expect(zshShells[0].path).toBe('/bin/zsh')
    })
  })

  describe('detectShells', () => {
    it('should return both default and available shells', () => {
      mockPlatform('win32')
      process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
      mockFileExists(() => false)

      const result = shellDetect.detectShells()

      expect(result.default).toBeDefined()
      expect(result.default?.name).toBe('cmd')
      expect(Array.isArray(result.available)).toBe(true)
    })
  })

  describe('getShellByName', () => {
    it('should return shell info when found', () => {
      mockPlatform('win32')
      mockFileExists(() => false)

      const shell = shellDetect.getShellByName('powershell')

      expect(shell).toEqual({
        path: 'powershell.exe',
        name: 'powershell',
        displayName: 'PowerShell'
      })
    })

    it('should return null when shell not found', () => {
      mockPlatform('win32')
      mockFileExists(() => false)

      const shell = shellDetect.getShellByName('nonexistent')

      expect(shell).toBeNull()
    })
  })

  describe('getHomeDirectory', () => {
    it('should return USERPROFILE on Windows', () => {
      mockPlatform('win32')
      process.env.USERPROFILE = 'C:\\Users\\TestUser'

      const home = shellDetect.getHomeDirectory()

      expect(home).toBe('C:\\Users\\TestUser')
    })

    it('should fallback to HOME on Windows if USERPROFILE not set', () => {
      mockPlatform('win32')
      delete process.env.USERPROFILE
      process.env.HOME = 'C:\\Users\\AltHome'

      const home = shellDetect.getHomeDirectory()

      expect(home).toBe('C:\\Users\\AltHome')
    })

    it('should fallback to C:\\ on Windows if neither set', () => {
      mockPlatform('win32')
      delete process.env.USERPROFILE
      delete process.env.HOME

      const home = shellDetect.getHomeDirectory()

      expect(home).toBe('C:\\')
    })

    it('should return HOME on Unix', () => {
      mockPlatform('linux')
      process.env.HOME = '/home/testuser'

      const home = shellDetect.getHomeDirectory()

      expect(home).toBe('/home/testuser')
    })

    it('should fallback to /tmp on Unix if HOME not set', () => {
      mockPlatform('linux')
      delete process.env.HOME

      const home = shellDetect.getHomeDirectory()

      expect(home).toBe('/tmp')
    })
  })
})
