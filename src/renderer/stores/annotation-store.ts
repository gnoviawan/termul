import { create } from 'zustand'

export type AnnotationType = 'note' | 'region' | 'element'
export type Intent = 'fix' | 'change' | 'question' | 'approve'
export type Severity = 'blocking' | 'important' | 'suggestion'
export type OutputLevel = 'compact' | 'standard' | 'detailed'

const MAX_TEXT_CONTENT_LENGTH = 2000
const MAX_SELECTOR_LENGTH = 500
const MAX_ATTRIBUTE_VALUE_LENGTH = 500
const ATTRIBUTE_ALLOWLIST = new Set([
  'id',
  'class',
  'name',
  'role',
  'type',
  'aria-label',
  'aria-describedby',
  'data-testid',
])

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

export interface ElementGeometry {
  type: 'element'
  tagName: string
  selector: string
  selectorConfidence: 'unique-id' | 'unique-class' | 'fallback'
  attributes: Record<string, string>
  textContent: string
  textTruncated: boolean
  boundingBox: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type AnnotationGeometry = RegionGeometry | NoteGeometry | ElementGeometry

export interface Annotation {
  id: string
  browserTabId: string
  url: string
  normalizedUrl: string
  pageTitle: string
  type: AnnotationType
  geometry: AnnotationGeometry
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
  selectedAnnotationIdByUrl: Map<string, string | null>

  // Actions
  addAnnotation: (annotation: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'>) => Annotation
  removeAnnotation: (normalizedUrl: string, id: string) => void
  updateAnnotation: (normalizedUrl: string, id: string, updates: Partial<Pick<Annotation, 'intent' | 'severity' | 'description'>>) => void
  getAnnotationsForUrl: (url: string) => Annotation[]
  clearAnnotationsForTab: (browserTabId: string) => void
  setSelectedAnnotationId: (normalizedUrl: string, id: string | null) => void
  clearSelectedAnnotationId: (normalizedUrl: string) => void
}

function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentional sanitization of captured text
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function sanitizeCapturedString(value: string): string {
  return stripControlChars(value)
}

function truncateWithEllipsis(value: string, maxLength: number): { value: string; truncated: boolean } {
  if (value.length <= maxLength) {
    return { value, truncated: false }
  }

  return {
    value: `${value.slice(0, Math.max(0, maxLength - 1))}…`,
    truncated: true,
  }
}

function toFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function sanitizeElementGeometry(geometry: ElementGeometry): ElementGeometry {
  const sanitizedTagName = sanitizeCapturedString(geometry.tagName)
  const sanitizedSelector = truncateWithEllipsis(sanitizeCapturedString(geometry.selector), MAX_SELECTOR_LENGTH).value
  const sanitizedAttributes = Object.fromEntries(
    Object.entries(geometry.attributes)
      .filter(([key]) => ATTRIBUTE_ALLOWLIST.has(key))
      .map(([key, value]) => {
        const sanitizedValue = truncateWithEllipsis(
          sanitizeCapturedString(String(value ?? '')),
          MAX_ATTRIBUTE_VALUE_LENGTH
        ).value
        return [key, sanitizedValue]
      })
  )

  const textResult = truncateWithEllipsis(
    sanitizeCapturedString(geometry.textContent),
    MAX_TEXT_CONTENT_LENGTH
  )

  return {
    ...geometry,
    tagName: sanitizedTagName,
    selector: sanitizedSelector,
    attributes: sanitizedAttributes,
    textContent: textResult.value,
    textTruncated: geometry.textTruncated || textResult.truncated,
    boundingBox: {
      x: toFiniteNumber(geometry.boundingBox.x),
      y: toFiniteNumber(geometry.boundingBox.y),
      width: toFiniteNumber(geometry.boundingBox.width),
      height: toFiniteNumber(geometry.boundingBox.height),
    },
  }
}

function sanitizeGeometry(geometry: AnnotationGeometry): AnnotationGeometry {
  if (geometry.type === 'element') {
    return sanitizeElementGeometry(geometry)
  }

  if (geometry.type === 'rect') {
    return {
      ...geometry,
      x: toFiniteNumber(geometry.x),
      y: toFiniteNumber(geometry.y),
      width: toFiniteNumber(geometry.width),
      height: toFiniteNumber(geometry.height),
    }
  }

  return {
    ...geometry,
    x: toFiniteNumber(geometry.x),
    y: toFiniteNumber(geometry.y),
  }
}

function sanitizeAnnotationData(
  annotationData: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'>
): Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'> {
  return {
    ...annotationData,
    url: sanitizeCapturedString(annotationData.url),
    normalizedUrl: sanitizeCapturedString(annotationData.normalizedUrl),
    pageTitle: sanitizeCapturedString(annotationData.pageTitle),
    geometry: sanitizeGeometry(annotationData.geometry),
  }
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
  selectedAnnotationIdByUrl: new Map(),

  addAnnotation: (annotationData) => {
    const id = crypto.randomUUID()
    const now = Date.now()
    const sanitizedAnnotationData = sanitizeAnnotationData(annotationData)
    const annotation: Annotation = {
      ...sanitizedAnnotationData,
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
      const selectedNext = new Map(state.selectedAnnotationIdByUrl)
      if (selectedNext.get(normalizedUrl) === id) {
        selectedNext.set(normalizedUrl, null)
      }
      return { annotationsByUrl: next, selectedAnnotationIdByUrl: selectedNext }
    })
  },

  updateAnnotation: (normalizedUrl, id, updates) => {
    set((state) => {
      const next = new Map(state.annotationsByUrl)
      const existing = next.get(normalizedUrl) ?? []
      let matched = false
      const updated = existing.map((a) => {
        if (a.id !== id) return a
        matched = true
        return {
          ...a,
          ...updates,
          updatedAt: Date.now(),
        }
      })
      if (!matched) return state
      if (updated.length === 0) {
        next.delete(normalizedUrl)
      } else {
        next.set(normalizedUrl, updated)
      }
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
      const selectedNext = new Map(state.selectedAnnotationIdByUrl)
      for (const [normalizedUrl, annotations] of state.annotationsByUrl) {
        const filtered = annotations.filter((a) => a.browserTabId !== browserTabId)
        if (filtered.length > 0) {
          next.set(normalizedUrl, filtered)
          const selectedId = selectedNext.get(normalizedUrl)
          if (selectedId !== null && selectedId !== undefined && !filtered.some((a) => a.id === selectedId)) {
            selectedNext.delete(normalizedUrl)
          }
        } else {
          selectedNext.delete(normalizedUrl)
        }
      }
      return { annotationsByUrl: next, selectedAnnotationIdByUrl: selectedNext }
    })
  },

  setSelectedAnnotationId: (normalizedUrl, id) => {
    set((state) => {
      const next = new Map(state.selectedAnnotationIdByUrl)
      next.set(normalizedUrl, id)
      return { selectedAnnotationIdByUrl: next }
    })
  },

  clearSelectedAnnotationId: (normalizedUrl) => {
    set((state) => {
      if (state.selectedAnnotationIdByUrl.get(normalizedUrl) === null) return state
      const next = new Map(state.selectedAnnotationIdByUrl)
      next.set(normalizedUrl, null)
      return { selectedAnnotationIdByUrl: next }
    })
  },
}))
