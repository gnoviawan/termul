/**
 * The launcher's record of the server it manages, so the next launch can find
 * a keep-alive server instead of spawning a second host on the same data dir.
 * `server.json` holds where it is; `server-token` holds its bearer token.
 * Both are owner-only (0600) and written through a temp file and rename.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface ServerRecord {
  pid: number
  port: number
  protocolVersion: number
  dataDir: string
  binary: string
  /** Started with keep-alive: nobody stops it on quit. */
  keepAlive: boolean
  startedAt: string
}

export interface StoredServer {
  record: ServerRecord
  token: string
}

const RECORD_FILE = 'server.json'
const TOKEN_FILE = 'server-token'

function writePrivate(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, contents, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

function isRecord(value: unknown): value is ServerRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    Number.isInteger(v.pid) &&
    Number.isInteger(v.port) &&
    Number.isInteger(v.protocolVersion) &&
    typeof v.dataDir === 'string' &&
    typeof v.binary === 'string' &&
    typeof v.keepAlive === 'boolean' &&
    typeof v.startedAt === 'string'
  )
}

export function readServerRecord(dir: string): StoredServer | null {
  try {
    const record: unknown = JSON.parse(readFileSync(path.join(dir, RECORD_FILE), 'utf8'))
    const token = readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim()
    return isRecord(record) && token ? { record, token } : null
  } catch {
    return null
  }
}

export function writeServerRecord(dir: string, stored: StoredServer): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writePrivate(path.join(dir, TOKEN_FILE), `${stored.token}\n`)
  writePrivate(path.join(dir, RECORD_FILE), `${JSON.stringify(stored.record, null, 2)}\n`)
}

/** Remove the record, but only while it still names `pid` (a newer launch may own it). */
export function clearServerRecord(dir: string, pid: number): void {
  const current = readServerRecord(dir)
  if (current && current.record.pid !== pid) return
  rmSync(path.join(dir, RECORD_FILE), { force: true })
  rmSync(path.join(dir, TOKEN_FILE), { force: true })
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
