import { useEffect, useRef, useState } from 'react'
import { useTerminalActions } from '@/stores/terminal-store'

// Cache for home directory to avoid repeated IPC calls
let cachedHomeDir: string | null = null

// Constants for path truncation
const TRUNCATE_START_LENGTH = 15
const TRUNCATE_ELLIPSIS_LENGTH = 3 // '...'

/**
 * Hook to subscribe to CWD changes for terminals
 * Updates the terminal store with the latest CWD for each terminal
 */
export function useCwd(): void {
  const { updateTerminalCwd } = useTerminalActions()
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Subscribe to CWD changed events from main process
    const cleanup = window.api.terminal.onCwdChanged((terminalId: string, cwd: string) => {
      updateTerminalCwd(terminalId, cwd)
    })

    cleanupRef.current = cleanup

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [updateTerminalCwd])
}

/**
 * Hook to get the home directory asynchronously
 * Caches the result to avoid repeated IPC calls
 */
export function useHomeDirectory(): string {
  const [homeDir, setHomeDir] = useState<string>(cachedHomeDir || '')

  useEffect(() => {
    if (cachedHomeDir !== null) return

    window.api.system.getHomeDirectory().then((result) => {
      if (result.success) {
        cachedHomeDir = result.data
        setHomeDir(result.data)
      }
    })
  }, [])

  return homeDir
}

/**
 * Format a path for display in the status bar
 * - Replaces home directory with ~
 * - Truncates long paths with ellipsis
 */
export function formatPath(
  fullPath: string,
  homeDir: string | undefined,
  maxLength: number = 50
): string {
  if (!fullPath) return ''

  let formatted = fullPath

  if (homeDir) {
    // Normalize both paths to use forward slashes for comparison
    const normalizedHome = homeDir.replace(/\\/g, '/')
    const normalizedPath = fullPath.replace(/\\/g, '/')

    // Check if path starts with home dir followed by a separator or is exactly home dir
    if (
      normalizedPath === normalizedHome ||
      normalizedPath.startsWith(normalizedHome + '/')
    ) {
      formatted = '~' + normalizedPath.slice(normalizedHome.length)
    } else {
      // Keep original path but normalize slashes for display consistency
      formatted = normalizedPath
    }
  }

  // Truncate if too long
  if (formatted.length > maxLength) {
    const start = formatted.slice(0, TRUNCATE_START_LENGTH)
    const endLength = maxLength - TRUNCATE_START_LENGTH - TRUNCATE_ELLIPSIS_LENGTH
    const end = formatted.slice(-endLength)
    return `${start}...${end}`
  }

  return formatted
}
