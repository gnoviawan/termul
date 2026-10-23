/**
 * One app per client state dir. The first launch listens on a local socket;
 * a second launch connects, asks the first to focus its window, and exits
 * without touching the server.
 *
 * Linux uses an abstract socket and Windows a named pipe: the OS frees both
 * when the holder dies, so a crash never leaves a stale lock. macOS has
 * neither and uses a socket file, removed on a refused connect.
 */

import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { log } from '../log'

export type InstanceClaim =
  | { kind: 'primary'; onFocusRequest(listener: () => void): void; release(): void }
  | { kind: 'secondary' }

const FOCUS_REQUEST = 'focus\n'
const CONNECT_TIMEOUT_MS = 1000

export function instanceAddress(
  stateDir: string,
  platform: NodeJS.Platform,
  launcherDir: string
): string {
  const user = os.userInfo().username
  const key = createHash('sha256')
    .update(`${user}\0${path.resolve(stateDir)}`)
    .digest('hex')
    .slice(0, 16)
  if (platform === 'linux') return `\0termul-gpuix-${key}`
  if (platform === 'win32') return `\\\\.\\pipe\\termul-gpuix-${key}`
  return path.join(launcherDir, 'instance.sock')
}

function askToFocus(address: string): Promise<'focused' | 'refused'> {
  return new Promise((resolve) => {
    const socket = net.connect(address)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('refused')
    }, CONNECT_TIMEOUT_MS)
    socket.once('connect', () => socket.write(FOCUS_REQUEST))
    socket.once('data', () => {
      clearTimeout(timer)
      socket.end()
      resolve('focused')
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve('refused')
    })
  })
}

function listen(address: string): Promise<net.Server | 'in_use'> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve('in_use')
      else reject(error)
    })
    server.listen(address, () => resolve(server))
  })
}

export async function claimInstance(
  address: string,
  isFileSocket: boolean
): Promise<InstanceClaim> {
  let server = await listen(address)
  if (server === 'in_use') {
    if ((await askToFocus(address)) === 'focused') return { kind: 'secondary' }
    // A socket file left by a crashed holder answers nobody.
    if (!isFileSocket) return { kind: 'secondary' }
    rmSync(address, { force: true })
    server = await listen(address)
    if (server === 'in_use') return { kind: 'secondary' }
  }
  const listening = server
  const listeners: (() => void)[] = []
  listening.on('connection', (socket) => {
    socket.once('data', (chunk) => {
      if (String(chunk) === FOCUS_REQUEST) {
        log.info('launcher', 'a second launch asked this window to focus')
        for (const listener of listeners) listener()
      }
      socket.end('ok\n')
    })
    socket.on('error', () => socket.destroy())
  })
  // The socket must not keep the process alive after the window closes.
  listening.unref()
  return {
    kind: 'primary',
    onFocusRequest: (listener) => listeners.push(listener),
    release: () => {
      listening.close()
      if (isFileSocket) rmSync(address, { force: true })
    }
  }
}
