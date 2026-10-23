/**
 * The OS capabilities the GPUIX process provides to the shared facades through
 * `src/renderer/lib/desktop-host.ts`: open a URL or file, reveal a file, post
 * a notification. Each action is a table of argv commands per platform, tried
 * in order until one exits 0. User text always travels as its own argv entry
 * (or an environment variable on Windows), never inside a shell string.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopHost } from '@/lib/desktop-host'
import { log } from '../log'

export type HostAction =
  | { kind: 'openUrl'; url: string }
  | { kind: 'openPath'; path: string }
  | { kind: 'reveal'; path: string }
  | { kind: 'notify'; title: string; body: string }

export interface HostCommand {
  argv: string[]
  env?: Record<string, string>
}

const WIN_NOTIFY = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$n = New-Object System.Windows.Forms.NotifyIcon',
  '$n.Icon = [System.Drawing.SystemIcons]::Information',
  '$n.Visible = $true',
  '$n.ShowBalloonTip(5000, $env:TERMUL_NOTIFY_TITLE, $env:TERMUL_NOTIFY_BODY, "Info")',
  'Start-Sleep -Seconds 6',
  '$n.Dispose()'
].join('; ')

/** The commands for one action, in fallback order. */
export function hostCommands(platform: NodeJS.Platform, action: HostAction): HostCommand[] {
  if (platform === 'darwin') {
    switch (action.kind) {
      case 'openUrl':
        return [{ argv: ['open', action.url] }]
      case 'openPath':
        return [{ argv: ['open', action.path] }]
      case 'reveal':
        return [{ argv: ['open', '-R', action.path] }]
      case 'notify':
        return [
          {
            argv: [
              'osascript',
              '-e',
              'on run argv',
              '-e',
              'display notification (item 2 of argv) with title (item 1 of argv)',
              '-e',
              'end run',
              action.title,
              action.body
            ]
          }
        ]
    }
  }
  if (platform === 'win32') {
    switch (action.kind) {
      case 'openUrl':
        return [{ argv: ['rundll32.exe', 'url.dll,FileProtocolHandler', action.url] }]
      case 'openPath':
        return [{ argv: ['explorer.exe', action.path] }]
      case 'reveal':
        return [{ argv: ['explorer.exe', `/select,${action.path}`] }]
      case 'notify':
        return [
          {
            argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WIN_NOTIFY],
            env: { TERMUL_NOTIFY_TITLE: action.title, TERMUL_NOTIFY_BODY: action.body }
          }
        ]
    }
  }
  switch (action.kind) {
    case 'openUrl':
      return [{ argv: ['xdg-open', action.url] }]
    case 'openPath':
      return [{ argv: ['xdg-open', action.path] }]
    case 'reveal':
      // The freedesktop FileManager1 interface selects the item; file
      // managers without it get the containing folder opened instead.
      return [
        {
          argv: [
            'gdbus',
            'call',
            '--session',
            '--dest',
            'org.freedesktop.FileManager1',
            '--object-path',
            '/org/freedesktop/FileManager1',
            '--method',
            'org.freedesktop.FileManager1.ShowItems',
            `['${pathToFileURL(action.path).href.replace(/'/g, '%27')}']`,
            ''
          ]
        },
        { argv: ['xdg-open', path.posix.dirname(action.path)] }
      ]
    case 'notify':
      return [{ argv: ['notify-send', '--app-name=Termul', action.title, action.body] }]
  }
}

export type CommandRunner = (command: HostCommand) => Promise<{ code: number; stderr: string }>

const COMMAND_TIMEOUT_MS = 10_000

export const spawnRunner: CommandRunner = async ({ argv, env }) => {
  try {
    const child = Bun.spawn(argv, {
      env: env ? { ...process.env, ...env } : process.env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: COMMAND_TIMEOUT_MS
    })
    const code = await child.exited
    return { code, stderr: (await new Response(child.stderr).text()).trim() }
  } catch (error) {
    return { code: -1, stderr: error instanceof Error ? error.message : String(error) }
  }
}

export async function runHostAction(
  platform: NodeJS.Platform,
  action: HostAction,
  run: CommandRunner = spawnRunner
): Promise<void> {
  const failures: string[] = []
  for (const command of hostCommands(platform, action)) {
    const { code, stderr } = await run(command)
    if (code === 0) return
    failures.push(`${command.argv[0]} exited ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
  }
  // Paths and URLs are the user's own data, but notification text can carry
  // agent output: log the action kind and the failure only.
  log.warn('desktop-host', `${action.kind} failed: ${failures.join('; ')}`)
  throw new Error(failures.join('; '))
}

export function createDesktopHost(platform: NodeJS.Platform = process.platform): DesktopHost {
  return {
    openUrl: (url) => runHostAction(platform, { kind: 'openUrl', url }),
    openPath: (target) => runHostAction(platform, { kind: 'openPath', path: target }),
    revealItemInDir: (target) => runHostAction(platform, { kind: 'reveal', path: target }),
    notify: (title, body) => runHostAction(platform, { kind: 'notify', title, body })
  }
}
