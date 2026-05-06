import { create } from 'zustand'

export type AnnotationType = 'note' | 'region'
export type Intent = 'fix' | 'change' | 'question' | 'approve'
export type Severity = 'blocking' | 'important' | 'suggestion'
export type OutputLevel = 'compact' | 'standard' | 'detailed'

export interface RegionGeometry {
  type: 'rect'
  x: number
  y: number
  width: number
  height: number
}

export interface NoteGeometry {
  type: 'point'
  x: number
  y: number
}

export interface Annotation {
  id: string
  browserTabId: string
  url: string
  normalizedUrl: string
  pageTitle: string
  type: AnnotationType
  geometry: RegionGeometry | NoteGeometry
  intent: Intent
  severity: Severity
  description: string
  viewportWidth: number
  viewportHeight: number
  schemaVersion: 1
  createdAt: number
  updatedAt: number
}

export const EMPTY_ANNOTATION_ARRAY: Annotation[] = []

export interface AnnotationState {
  annotationsByUrl: Map<string, Annotation[]>

  // Actions
  addAnnotation: (annotation: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'>) => Annotation
  removeAnnotation: (normalizedUrl: string, id: string) => void
  updateAnnotation: (normalizedUrl: string, id: string, updates: Partial<Pick<Annotation, 'intent' | 'severity' | 'description'>>) => void
  getAnnotationsForUrl: (url: string) => Annotation[]
  clearAnnotationsForTab: (browserTabId: string) => void
}

/**
 * Normalize a URL for use as a lookup key.
 * - Strip utm_*, fbclid, gclid query params
 * - Strip hash anchors
 * - Normalize trailing slash
 * - Lowercase host
 */
export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    // Lowercase host
    url.host = url.host.toLowerCase()
    // Strip tracking params
    const stripParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']
    for (const param of stripParams) {
      url.searchParams.delete(param)
    }
    // Strip hash
    url.hash = ''
    // Normalize trailing slash for pathname (only root)
    let result = url.toString()
    if (url.pathname === '/' && result.endsWith('/')) {
      result = result.slice(0, -1)
    }
    return result
  } catch {
    return rawUrl
  }
}

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  annotationsByUrl: new Map(),

  addAnnotation: (annotationData) => {
    const id = crypto.randomUUID()
    const now = Date.now()
    const annotation: Annotation = {
      ...annotationData,
      id,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    }

    set((state) => {
      const next = new Map(state.annotationsByUrl)
      const existing = next.get(annotation.normalizedUrl) ?? []
      next.set(annotation.normalizedUrl, [...existing, annotation])
      return { annotationsByUrl: next }
    })

    return annotation
  },

  removeAnnotation: (normalizedUrl, id) => {
    set((state) => {
      const next = new Map(state.annotationsByUrl)
      const existing = next.get(normalizedUrl) ?? []
      const filtered = existing.filter((a) => a.id !== id)
      if (filtered.length === 0) {
        next.delete(normalizedUrl)
      } else {
        next.set(normalizedUrl, filtered)
      }
      return { annotationsByUrl: next }
    })
  },

  updateAnnotation: (normalizedUrl, id, updates) => {
    set((state) => {
      const next = new Map(state.annotationsByUrl)
      const existing = next.get(normalizedUrl) ?? []
      const updated = existing.map((a) => {
        if (a.id !== id) return a
        return {
          ...a,
          ...updates,
          updatedAt: Date.now(),
        }
      })
      next.set(normalizedUrl, updated)
      return { annotationsByUrl: next }
    })
  },

  getAnnotationsForUrl: (url) => {
    const normalized = normalizeUrl(url)
    return get().annotationsByUrl.get(normalized) ?? EMPTY_ANNOTATION_ARRAY
  },

  clearAnnotationsForTab: (browserTabId) => {
    set((state) => {
      const next = new Map<string, Annotation[]>()
      for (const [normalizedUrl, annotations] of state.annotationsByUrl) {
        const filtered = annotations.filter((a) => a.browserTabId !== browserTabId)
        if (filtered.length > 0) {
          next.set(normalizedUrl, filtered)
        }
      }
      return { annotationsByUrl: next }
    })
  },
}))
