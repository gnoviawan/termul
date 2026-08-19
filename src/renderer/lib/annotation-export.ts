import { runtimeT } from '@/i18n/runtime'
import type { Annotation, ElementGeometry, OutputLevel } from '@/stores/annotation-store'

function exportT(key: string, fallback: string): string {
  return runtimeT('browser', `export.markdownLabels.${key}`, fallback)
}

function formatAnnotationType(type: Annotation['type']): string {
  return runtimeT('browser', `export.annotationType.${type}`, type)
}

function formatIntent(intent: Annotation['intent']): string {
  return runtimeT('browser', `annotation.intent.${intent}`, intent)
}

function formatSeverity(severity: Annotation['severity']): string {
  return runtimeT('browser', `annotation.severity.${severity}`, severity)
}

function formatSelectorConfidence(confidence: ElementGeometry['selectorConfidence']): string {
  return runtimeT('browser', `annotation.selectorConfidence.${confidence}`, confidence)
}

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
  return `${escapeMarkdown(geometry.tagName)} > ${escapeMarkdown(truncateForExport(geometry.selector, 60))} (${formatSelectorConfidence(geometry.selectorConfidence)})`
}

function formatElementTextPreview(geometry: ElementGeometry): string {
  return escapeMarkdown(
    truncateForExport(geometry.textContent, 80) || exportT('noText', '(no text)')
  )
}

function formatElementBoundingBox(geometry: ElementGeometry): string {
  return `x=${Math.round(geometry.boundingBox.x)}, y=${Math.round(geometry.boundingBox.y)}, w=${Math.round(geometry.boundingBox.width)}, h=${Math.round(geometry.boundingBox.height)}`
}

export function exportAnnotationsToMarkdown(annotations: Annotation[], level: OutputLevel): string {
  if (annotations.length === 0) {
    return exportT('noAnnotations', 'No annotations.')
  }

  const lines: string[] = []
  const title = annotations[0]?.pageTitle ?? exportT('titleFallback', 'Annotations')
  const url = annotations[0]?.url ?? ''

  lines.push(`# ${escapeMarkdown(title)}`)
  if (url) {
    lines.push(`> ${escapeMarkdown(url)}`)
  }
  lines.push('')

  if (level === 'compact') {
    annotations.forEach((a, i) => {
      if (a.type === 'region' && a.geometry.type === 'rect') {
        lines.push(
          `${i + 1}. ${formatRect(a.geometry)} > ${escapeMarkdown(
            a.description || exportT('noComment', '(no comment)')
          )}`
        )
      } else if (a.type === 'element' && a.geometry.type === 'element') {
        lines.push(
          `${i + 1}. ${formatElementCompact(a.geometry)} > ${escapeMarkdown(
            a.description || exportT('noComment', '(no comment)')
          )}`
        )
      } else {
        lines.push(
          `${i + 1}. ${exportT('note', 'note')} > ${escapeMarkdown(
            a.description || exportT('noComment', '(no comment)')
          )}`
        )
      }
    })
  } else if (level === 'standard') {
    annotations.forEach((a, i) => {
      lines.push(
        `${i + 1}. **[${formatIntent(a.intent)}]** *${formatSeverity(a.severity)}* — ${escapeMarkdown(
          a.description || exportT('noDescription', '(no description)')
        )}`
      )
      if (a.type === 'region' && a.geometry.type === 'rect') {
        lines.push(`   ${exportT('region', 'Region')}: ${formatRect(a.geometry)}`)
      } else if (a.type === 'element' && a.geometry.type === 'element') {
        lines.push(`   ${exportT('element', 'Element')}: ${formatElementCompact(a.geometry)}`)
        lines.push(`   ${exportT('text', 'Text')}: ${formatElementTextPreview(a.geometry)}`)
      }
      lines.push('')
    })
  } else {
    annotations.forEach((a, i) => {
      lines.push(`## ${exportT('annotation', 'Annotation')} ${i + 1}`)
      lines.push(`- **${exportT('type', 'Type')}:** ${formatAnnotationType(a.type)}`)
      lines.push(`- **${exportT('intent', 'Intent')}:** ${formatIntent(a.intent)}`)
      lines.push(`- **${exportT('severity', 'Severity')}:** ${formatSeverity(a.severity)}`)
      lines.push(
        `- **${exportT('description', 'Description')}:** ${escapeMarkdown(
          a.description || exportT('none', '(none)')
        )}`
      )
      if (a.type === 'region' && a.geometry.type === 'rect') {
        lines.push(`- **${exportT('geometry', 'Geometry')}:** ${formatRect(a.geometry)}`)
      } else if (a.type === 'element' && a.geometry.type === 'element') {
        lines.push(`- **${exportT('tag', 'Tag')}:** ${escapeMarkdown(a.geometry.tagName)}`)
        lines.push(
          `- **${exportT('selector', 'Selector')}:** ${escapeMarkdown(a.geometry.selector)}`
        )
        lines.push(
          `- **${exportT('selectorConfidence', 'Selector Confidence')}:** ${formatSelectorConfidence(a.geometry.selectorConfidence)}`
        )
        lines.push(
          `- **${exportT('textPreview', 'Text Preview')}:** ${formatElementTextPreview(a.geometry)}`
        )
        lines.push(
          `- **${exportT('boundingBox', 'Bounding Box')}:** ${formatElementBoundingBox(a.geometry)}`
        )
        lines.push('')
        lines.push(`| ${exportT('attribute', 'Attribute')} | ${exportT('value', 'Value')} |`)
        lines.push('| --- | --- |')
        const entries = Object.entries(a.geometry.attributes)
        if (entries.length === 0) {
          lines.push(`| ${exportT('none', '(none)')} | |`)
        } else {
          entries.forEach(([key, value]) => {
            lines.push(`| ${escapeMarkdown(key)} | ${escapeMarkdown(value)} |`)
          })
        }
      }
      lines.push(`- **${exportT('viewport', 'Viewport')}:** ${a.viewportWidth}x${a.viewportHeight}`)
      lines.push(`- **${exportT('created', 'Created')}:** ${new Date(a.createdAt).toISOString()}`)
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
      updatedAt: a.updatedAt
    }))
  }
  return JSON.stringify(payload, null, 2)
}

// ── AFS (Agentation Format Schema) adapter ──────────────────────────────
// AFS-unsupported fields that MUST be absent from output:
const AFS_UNSUPPORTED_FIELDS = new Set([
  'status',
  'thread',
  'resolvedBy',
  'resolvedAt',
  'reactComponents',
  'cssClasses',
  'computedStyles',
  'accessibility',
  'nearbyText',
  'selectedText',
  'isFixed',
  'isMultiSelect',
  'fullPath',
  'nearbyElements',
  'kind',
  'placement',
  'rearrange'
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
    severity: a.severity
  }

  if (a.type === 'element' && a.geometry.type === 'element') {
    const geo = a.geometry
    entry.elementPath = geo.selector
    entry.element = geo.tagName
    entry.x = a.viewportWidth > 0 ? (geo.boundingBox.x / a.viewportWidth) * 100 : geo.boundingBox.x
    entry.y = geo.boundingBox.y
    entry.boundingBox = { ...geo.boundingBox }
  } else if (a.type === 'region' && a.geometry.type === 'rect') {
    const geo = a.geometry
    entry.elementPath = formatRect(geo)
    entry.element = 'div'
    entry.x = a.viewportWidth > 0 ? (geo.x / a.viewportWidth) * 100 : geo.x
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
