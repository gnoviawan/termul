import type { ProbeStatus } from '@/lib/acp-api'

export interface ConnectorServer {
  id: string
  name: string
  enabled?: boolean
}

export interface ConnectorRow {
  id: string
  name: string
  on: boolean
  /** The probe needs a sign-in: the row opens settings instead of toggling. */
  needsSignIn: boolean
}

/**
 * Which composer hosts the menu. The launcher's toggle applies to the chat it
 * starts. A running chat keeps the servers it started with, so it reports
 * whether they still match the list.
 */
export type ConnectorsHost = 'launcher' | 'chat-current' | 'chat-stale'

/** What the menu says under the rows. */
export type ConnectorsFootnote = 'none' | 'next-chat' | 'reload-chat'

export interface ConnectorsMenuModel {
  rows: ConnectorRow[]
  /** Servers switched on, shown on the Connectors row as "N on". */
  onCount: number
  footnote: ConnectorsFootnote
}

const FOOTNOTE: Record<ConnectorsHost, ConnectorsFootnote> = {
  launcher: 'next-chat',
  'chat-current': 'none',
  'chat-stale': 'reload-chat'
}

/** A server is on unless the registry says otherwise (the stored default is on). */
export function connectorIsOn(server: ConnectorServer): boolean {
  return server.enabled !== false
}

export function connectorsMenuModel(
  servers: readonly ConnectorServer[],
  probeStatus: Readonly<Record<string, ProbeStatus>> | undefined,
  host: ConnectorsHost
): ConnectorsMenuModel {
  const rows = servers.map((server) => ({
    id: server.id,
    name: server.name,
    on: connectorIsOn(server),
    needsSignIn: probeStatus?.[server.id] === 'authRequired'
  }))
  return {
    rows,
    onCount: rows.filter((row) => row.on).length,
    footnote: rows.length === 0 ? 'none' : FOOTNOTE[host]
  }
}
