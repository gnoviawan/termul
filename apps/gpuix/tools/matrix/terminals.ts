/**
 * Closes every terminal the server preserves for the seeded projects, so one
 * surface's terminals never count against the next surface's per-project
 * limit (10 per project, 30 total). Preserved PTYs outlive the client that
 * opened them, so without this a full run hits the limit by the terminal
 * tab surfaces and both clients fail to open a terminal.
 *
 * `/terminal/ws` lets a connection kill only a terminal it attached to, so
 * this lists each project's preserved terminals (which issues a claim per
 * terminal), attaches with that claim, then kills.
 */

import { WS_PROTOCOL_VERSION } from '../../../../src/shared/types/web-protocol.types.ts'
import { commandId } from '../shared/ws'
import { PROJECTS, TOKEN, type World } from './world'

interface Reply {
  id: string
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

interface Preserved {
  id: string
  claim?: string
  hasLiveAttachment: boolean
}

const TIMEOUT_MS = 10_000

export async function killTerminals(world: World): Promise<number> {
  const socket = new WebSocket(`${world.server.baseUrl.replace(/^http/, 'ws')}/terminal/ws`)
  const pending = new Map<string, (reply: Reply) => void>()
  let next = 0
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as Partial<Reply>
    if (typeof frame.id !== 'string') return
    pending.get(frame.id)?.(frame as Reply)
    pending.delete(frame.id)
  }
  const request = async <T>(type: string, payload: unknown, command?: string): Promise<T> => {
    const id = `m-${next++}`
    const reply = await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`terminal ${type} timed out`)), TIMEOUT_MS)
      pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      socket.send(JSON.stringify({ id, type, payload, ...(command ? { commandId: command } : {}) }))
    })
    if (!reply.success) throw new Error(`terminal ${type}: ${reply.code} ${reply.error}`)
    return reply.data as T
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('terminal ws connect failed'))
  })
  let killed = 0
  try {
    await request('authenticate', {
      protocolVersion: WS_PROTOCOL_VERSION,
      deviceId: 'm1-terminal-sweep',
      clientInstanceId: `m1-terminal-sweep-${crypto.randomUUID()}`,
      token: TOKEN
    })
    for (const project of Object.values(PROJECTS)) {
      const { terminals } = await request<{ terminals: Preserved[] }>('list_preserved', {
        projectId: project.id
      })
      for (const terminal of terminals) {
        if (!terminal.claim) {
          console.error(`[matrix] terminal ${terminal.id} still has a live client; left open`)
          continue
        }
        await request('attach', { terminalId: terminal.id, claim: terminal.claim })
        await request('kill', { terminalId: terminal.id }, commandId('kill'))
        killed++
      }
    }
  } finally {
    socket.close()
  }
  return killed
}
