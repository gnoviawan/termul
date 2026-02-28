import { useRef, useEffect, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { invoke } from '@tauri-apps/api/core'
import { platform } from '@tauri-apps/plugin-os'
import { spawn } from 'tauri-pty'
import type { ShellInfo } from '@/lib/tauri-types'
import {
  TERMINAL_THEME,
  DEFAULT_TERMINAL_OPTIONS,
  RESIZE_DEBOUNCE_MS
} from '@/components/terminal/terminal-config'
import '@xterm/xterm/css/xterm.css'

const CONPTY_MIN_BUILD_NUMBER = 21376
const MAX_WEBGL_RETRIES = 3

type TerminalStatus = 'loading' | 'ready' | 'exited' | 'error'

export function TauriTerminal(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const ptyRef = useRef<ReturnType<typeof spawn> | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('loading')
  const [errorMsg, setErrorMsg] = useState<string>('')

  const initTerminal = useCallback(async () => {
    if (!containerRef.current) return

    try {
      // Detect platform for ConPTY settings
      const os = platform()
      const isWindows = os === 'windows'

      // Create terminal with platform-aware options
      const termOptions = {
        ...DEFAULT_TERMINAL_OPTIONS,
        theme: TERMINAL_THEME,
        ...(isWindows && {
          windowsPty: {
            backend: 'conpty' as const,
            buildNumber: CONPTY_MIN_BUILD_NUMBER
          }
        })
      }

      const term = new Terminal(termOptions)
      termRef.current = term

      // FitAddon
      const fitAddon = new FitAddon()
      fitAddonRef.current = fitAddon
      term.loadAddon(fitAddon)

      // Open terminal in container
      term.open(containerRef.current)
      fitAddon.fit()

      // WebGL addon with fallback
      let webglAttempts = 0
      const loadWebgl = (): void => {
        if (webglAttempts >= MAX_WEBGL_RETRIES) {
          console.warn('[TauriTerminal] WebGL failed after max retries, using canvas renderer')
          return
        }
        try {
          const webglAddon = new WebglAddon()
          webglAddon.onContextLoss(() => {
            webglAddon.dispose()
            webglAttempts++
            loadWebgl()
          })
          term.loadAddon(webglAddon)
        } catch {
          webglAttempts++
          console.warn(`[TauriTerminal] WebGL attempt ${webglAttempts} failed`)
          loadWebgl()
        }
      }
      loadWebgl()

      // Shell detection
      let shellInfo: ShellInfo
      try {
        shellInfo = await invoke<ShellInfo>('get_default_shell')
      } catch (err) {
        const msg = `Shell detection gagal: ${err}`
        setErrorMsg(msg)
        setStatus('error')
        term.writeln(`\r\n\x1b[31m[Error] ${msg}\x1b[0m`)
        return
      }

      // Get home directory for initial CWD
      let cwd: string
      try {
        cwd = await invoke<string>('get_home_directory')
      } catch {
        cwd = isWindows ? 'C:\\' : '/tmp'
      }

      // Spawn PTY
      const { cols, rows } = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 }
      const pty = spawn(shellInfo.path, shellInfo.args ?? [], {
        cols,
        rows,
        cwd,
      })
      ptyRef.current = pty

      // Data I/O: PTY → Terminal
      pty.onData((data) => {
        term.write(data)
      })

      // Data I/O: Terminal → PTY
      term.onData((data: string) => {
        pty.write(data)
      })

      // PTY exit handler
      pty.onExit(({ exitCode }: { exitCode: number }) => {
        console.log(`[TauriTerminal] PTY exited with code ${exitCode}`)
        term.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`)
        term.options.disableStdin = true
        setStatus('exited')
      })

      // ResizeObserver for auto-fit
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = setTimeout(() => {
          if (!fitAddonRef.current || !ptyRef.current || !termRef.current) return
          try {
            fitAddonRef.current.fit()
            const dims = fitAddonRef.current.proposeDimensions()
            if (dims) {
              ptyRef.current.resize(dims.cols, dims.rows)
            }
          } catch {
            // Ignore resize errors during teardown
          }
        }, RESIZE_DEBOUNCE_MS)
      })
      resizeObserver.observe(containerRef.current)

      setStatus('ready')

      // Store observer for cleanup
      ;(containerRef.current as HTMLDivElement & { _resizeObserver?: ResizeObserver })._resizeObserver = resizeObserver
    } catch (err) {
      const msg = `Terminal initialization gagal: ${err}`
      setErrorMsg(msg)
      setStatus('error')
      console.error('[TauriTerminal]', msg)
    }
  }, [])

  useEffect(() => {
    initTerminal()

    return () => {
      // Cleanup
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)

      const container = containerRef.current as (HTMLDivElement & { _resizeObserver?: ResizeObserver }) | null
      if (container?._resizeObserver) {
        container._resizeObserver.disconnect()
      }

      try {
        ptyRef.current?.kill()
      } catch {
        // PTY may already be dead
      }

      termRef.current?.dispose()
      ptyRef.current = null
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [initTerminal])

  if (status === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#1e1e1e] text-red-400 p-4">
        <div className="text-center">
          <p className="text-lg font-semibold mb-2">Terminal Error</p>
          <p className="text-sm text-red-300">{errorMsg}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 relative bg-[#1e1e1e]">
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm z-10">
          Loading terminal...
        </div>
      )}
      <div
        ref={containerRef}
        className="absolute inset-0 p-1"
      />
    </div>
  )
}
