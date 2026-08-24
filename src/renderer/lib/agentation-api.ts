/**
 * Renderer facade for the agentation annotation API (issue #451, Epic 1.7).
 *
 * This module provides a runtime-neutral API for the renderer to interact
 * with the in-process Rust agentation service. In the Tauri desktop build,
 * it delegates to Tauri commands. In the browser/web build, it delegates
 * to the HTTP server's REST API directly.
 *
 * The Zustand annotation store becomes a projection of Rust core state —
 * the Rust backend is the source of truth, and the renderer reads/writes
 * through this facade.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from './tauri-runtime'
// --- Types (mirror the Rust types in agentation/types.rs) ---

export type AnnotationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed'
export type SessionStatus = 'active' | 'approved' | 'closed'
export type AnnotationKind = 'feedback' | 'placement' | 'rearrange'
export type ThreadRole = 'human' | 'agent'

export interface AgentationSession {
  id: string
  url: string
  status: SessionStatus
  createdAt: string
  updatedAt?: string
  projectId?: string
}

export interface AgentationAnnotation {
  id: string
  sessionId: string
  x: number
  y: number
  comment: string
  element: string
  elementPath: string
  timestamp: number
  kind: AnnotationKind
  status: AnnotationStatus
  url?: string
  intent?: string
  severity?: string
  nearbyText?: string
  reactComponents?: string
  thread?: Array<{ id: string; role: ThreadRole; content: string; timestamp: number }>
  createdAt: string
  updatedAt?: string
  resolvedAt?: string
  resolvedBy?: string
}

export interface AgentationPending {
  count: number
  annotations: AgentationAnnotation[]
}

// --- API facade ---

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args)
}

async function httpGet<T>(path: string): Promise<T> {
  const port = (window as any).__TERMUL_AGENTATION_PORT__ ?? 0
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function httpPost<T>(path: string, body: unknown): Promise<T> {
  const port = (window as any).__TERMUL_AGENTATION_PORT__ ?? 0
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function httpPatch<T>(path: string, body: unknown): Promise<T> {
  const port = (window as any).__TERMUL_AGENTATION_PORT__ ?? 0
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export const agentationApi = {
  // Sessions
  async createSession(url: string, projectId?: string): Promise<AgentationSession> {
    if (isTauriContext()) {
      return tauriInvoke('agentation_create_session', { url, projectId })
    }
    return httpPost('/sessions', { url, projectId })
  },

  async listSessions(): Promise<AgentationSession[]> {
    if (isTauriContext()) {
      return tauriInvoke<AgentationSession[]>('agentation_list_sessions')
    }
    return httpGet<AgentationSession[]>('/sessions')
  },

  async getSession(
    id: string
  ): Promise<{ session: AgentationSession; annotations: AgentationAnnotation[] }> {
    if (isTauriContext()) {
      return tauriInvoke('agentation_get_session', { sessionId: id })
    }
    return httpGet(`/sessions/${id}`)
  },

  // Annotations
  async getPending(sessionId: string): Promise<AgentationPending> {
    if (isTauriContext()) {
      return tauriInvoke('agentation_get_pending', { sessionId })
    }
    return httpGet(`/sessions/${sessionId}/pending`)
  },

  async getAllPending(): Promise<AgentationPending> {
    if (isTauriContext()) {
      return tauriInvoke<AgentationPending>('agentation_get_all_pending')
    }
    return httpGet('/pending')
  },

  async acknowledge(annotationId: string): Promise<void> {
    if (isTauriContext()) {
      await tauriInvoke('agentation_acknowledge', { annotationId })
      return
    }
    await httpPatch(`/annotations/${annotationId}`, { status: 'acknowledged' })
  },

  async resolve(annotationId: string, summary?: string): Promise<void> {
    if (isTauriContext()) {
      await tauriInvoke('agentation_resolve', { annotationId, summary })
      return
    }
    await httpPatch(`/annotations/${annotationId}`, { status: 'resolved', resolvedBy: 'agent' })
    if (summary) {
      await httpPost(`/annotations/${annotationId}/thread`, {
        role: 'agent',
        content: `Resolved: ${summary}`
      })
    }
  },

  async dismiss(annotationId: string, reason: string): Promise<void> {
    if (isTauriContext()) {
      await tauriInvoke('agentation_dismiss', { annotationId, reason })
      return
    }
    await httpPatch(`/annotations/${annotationId}`, { status: 'dismissed', resolvedBy: 'agent' })
    await httpPost(`/annotations/${annotationId}/thread`, {
      role: 'agent',
      content: `Dismissed: ${reason}`
    })
  },

  async reply(annotationId: string, message: string): Promise<void> {
    if (isTauriContext()) {
      await tauriInvoke('agentation_reply', { annotationId, message })
      return
    }
    await httpPost(`/annotations/${annotationId}/thread`, { role: 'agent', content: message })
  },

  // Feature flag
  async setEnabled(enabled: boolean): Promise<void> {
    const tauri = isTauriContext()
    console.log('[Agentation API] setEnabled called: enabled=', enabled, 'isTauriContext=', tauri)
    if (tauri) {
      await tauriInvoke('agentation_set_enabled', { enabled })
      console.log('[Agentation API] tauriInvoke succeeded')
    }
  },
  async isEnabled(): Promise<boolean> {
    if (isTauriContext()) {
      return tauriInvoke<boolean>('agentation_is_enabled')
    }
    return false
  }
}
