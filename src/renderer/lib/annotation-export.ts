import type { Annotation, ElementGeometry, OutputLevel } from '@/stores/annotation-store'

function truncateForExport(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1')
}

function formatRect(geometry: { x: number; y: number; width: number; height: number }): string {
  return `rect(${Math.round(geometry.x)}, ${Math.round(geometry.y)}, ${Math.round(geometry.width)}, ${Math.round(geometry.height)})`
}

function formatElementCompact(geometry: ElementGeometry): string {
  return `${escapeMarkdown(geometry.tagName)} > ${escapeMarkdown(truncateForExport(geometry.selector, 60))} (${geometry.selectorConfidence})`
}

function formatElementTextPreview(geometry: ElementGeometry): string {
  return escapeMarkdown(truncateForExport(geometry.textContent, 80) || '(no text)')
}

function formatElementBoundingBox(geometry: ElementGeometry): string {
  return `x=${Math.round(geometry.boundingBox.x)}, y=${Math.round(geometry.boundingBox.y)}, w=${Math.round(geometry.boundingBox.width)}, h=${Math.round(geometry.boundingBox.height)}`
}

export function exportAnnotationsToMarkdown(annotations: Annotation[], level: OutputLevel): string {
  if (annotations.length === 0) {
    return 'No annotations.'
  }

  const lines: string[] = []
  const title = annotations[0]?.pageTitle || 'Annotations'
  const url = annotations[0]?.url || ''

  lines.push(`# ${escapeMarkdown(title)}`)
  if (url) {
    lines.push(`> ${escapeMarkdown(url)}`)
  }
  lines.push('')

  if (level === 'compact') {
    annotations.forEach((a, i) => {
      if (a.type === 'region' && a.geometry.type === 'rect') {
        lines.push(`${i + 1}. ${formatRect(a.geometry)} > ${escapeMarkdown(a.description || '(no comment)')}`)
      } else if (a.type === 'element' && a.geometry.type === 'element') {
        lines.push(`${i + 1}. ${formatElementCompact(a.geometry)} > ${escapeMarkdown(a.description || '(no comment)')}`)
      } else {
        lines.push(`${i + 1}. note > ${escapeMarkdown(a.description || '(no comment)')}`)
      }
    })
  } else if (level === 'standard') {
    annotations.forEach((a, i) => {
      lines.push(`${i + 1}. **[${a.intent}]** *${a.severity}* — ${escapeMarkdown(a.description || '(no description)')}`)
      if (a.type === 'region' && a.geometry.type === 'rect') {
        lines.push(`   Region: ${formatRect(a.geometry)}`)
      } else if (a.type === 'element' && a.geometry.type === 'element') {
        lines.push(`   Element: ${formatElementCompact(a.geometry)}`)
        lines.push(`   Text: ${formatElementTextPreview(a.geometry)}`)
      }
      lines.push('')
    })
  } else {
    annotations.forEach((a, i) => {
      lines.push(`## Annotation ${i + 1}`)
      lines.push(`- **Type:** ${a.type}`)
      lines.push(`- **Intent:** ${a.intent}`)
      lines.push(`- **Severity:** ${a.severity}`)
      lines.push(`- **Description:** ${escapeMarkdown(a.description || '(none)')}`)
      if (a.type === 'region' && a.geometry.type === 'rect') {
        lines.push(`- **Geometry:** ${formatRect(a.geometry)}`)
      } else if (a.type === 'element' && a.geometry.type === 'element') {
        lines.push(`- **Tag:** ${escapeMarkdown(a.geometry.tagName)}`)
        lines.push(`- **Selector:** ${escapeMarkdown(a.geometry.selector)}`)
        lines.push(`- **Selector Confidence:** ${a.geometry.selectorConfidence}`)
        lines.push(`- **Text Preview:** ${formatElementTextPreview(a.geometry)}`)
        lines.push(`- **Bounding Box:** ${formatElementBoundingBox(a.geometry)}`)
        lines.push('')
        lines.push('| Attribute | Value |')
        lines.push('| --- | --- |')
        const entries = Object.entries(a.geometry.attributes)
        if (entries.length === 0) {
          lines.push('| (none) | |')
        } else {
          entries.forEach(([key, value]) => {
            lines.push(`| ${escapeMarkdown(key)} | ${escapeMarkdown(value)} |`)
          })
        }
      }
      lines.push(`- **Viewport:** ${a.viewportWidth}x${a.viewportHeight}`)
      lines.push(`- **Created:** ${new Date(a.createdAt).toISOString()}`)
      lines.push('')
    })
  }

  return lines.join('\n')
}

export function exportAnnotationsToJson(annotations: Annotation[]): string {
  const payload = {
    schemaVersion: 1,
    exportedAt: Date.now(),
    annotations: annotations.map((a) => ({
      id: a.id,
      url: a.url,
      normalizedUrl: a.normalizedUrl,
      pageTitle: a.pageTitle,
      type: a.type,
      geometry: a.geometry,
      intent: a.intent,
      severity: a.severity,
      description: a.description,
      viewportWidth: a.viewportWidth,
      viewportHeight: a.viewportHeight,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
  }
  return JSON.stringify(payload, null, 2)
}

// ── AFS (Agentation Format Schema) adapter ──────────────────────────────
// AFS-unsupported fields that MUST be absent from output:
const AFS_UNSUPPORTED_FIELDS = new Set([
  'status', 'thread', 'resolvedBy', 'resolvedAt',
  'reactComponents', 'cssClasses', 'computedStyles',
  'accessibility', 'nearbyText', 'selectedText',
  'isFixed', 'isMultiSelect', 'fullPath', 'nearbyElements',
  'kind', 'placement', 'rearrange',
])

export function exportAnnotationsToAfsJson(annotations: Annotation[]): string {
  const afsAnnotations = annotations.map((a) => mapAnnotationToAfs(a))
  return JSON.stringify({ annotations: afsAnnotations }, null, 2)
}

function mapAnnotationToAfs(a: Annotation): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: a.id,
    comment: a.description ?? '',
    timestamp: a.createdAt,
    url: a.url,
    intent: a.intent,
    severity: a.severity,
  }

  if (a.type === 'element' && a.geometry.type === 'element') {
    const geo = a.geometry
    entry.elementPath = geo.selector
    entry.element = geo.tagName
    entry.x = (geo.boundingBox.x / a.viewportWidth) * 100
    entry.y = geo.boundingBox.y
    entry.boundingBox = { ...geo.boundingBox }
  } else if (a.type === 'region' && a.geometry.type === 'rect') {
    const geo = a.geometry
    entry.elementPath = formatRect(geo)
    entry.element = 'div'
    entry.x = (geo.x / a.viewportWidth) * 100
    entry.y = geo.y
    entry.boundingBox = { x: geo.x, y: geo.y, width: geo.width, height: geo.height }
  } else {
    // note (or any type we can't map geometrically)
    entry.element = 'body'
    entry.x = 0
    entry.y = 0
  }

  // Belt-and-suspenders: strip any AFS-unsupported keys that may have leaked.
  for (const key of Object.keys(entry)) {
    if (AFS_UNSUPPORTED_FIELDS.has(key)) {
      delete entry[key]
    }
  }

  return entry
}
