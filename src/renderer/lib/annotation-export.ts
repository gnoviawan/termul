import type { Annotation, OutputLevel } from '@/stores/annotation-store'

export function exportAnnotationsToMarkdown(annotations: Annotation[], level: OutputLevel): string {
  if (annotations.length === 0) {
    return 'No annotations.'
  }

  const lines: string[] = []
  const title = annotations[0]?.pageTitle || 'Annotations'
  const url = annotations[0]?.url || ''

  lines.push(`# ${title}`)
  if (url) {
    lines.push(`> ${url}`)
  }
  lines.push('')

  if (level === 'compact') {
    annotations.forEach((a, i) => {
      if (a.type === 'region') {
        const g = a.geometry as { type: 'rect'; x: number; y: number; width: number; height: number }
        lines.push(`${i + 1}. rect(${Math.round(g.x)},${Math.round(g.y)},${Math.round(g.width)},${Math.round(g.height)}) > ${a.description || '(no comment)'}`)
      } else {
        lines.push(`${i + 1}. note > ${a.description || '(no comment)'}`)
      }
    })
  } else if (level === 'standard') {
    annotations.forEach((a, i) => {
      lines.push(`${i + 1}. **[${a.intent}]** *${a.severity}* — ${a.description || '(no description)'}`)
      if (a.type === 'region') {
        const g = a.geometry as { type: 'rect'; x: number; y: number; width: number; height: number }
        lines.push(`   Region: rect(${Math.round(g.x)}, ${Math.round(g.y)}, ${Math.round(g.width)}, ${Math.round(g.height)})`)
      }
      lines.push('')
    })
  } else {
    // detailed
    annotations.forEach((a, i) => {
      lines.push(`## Annotation ${i + 1}`)
      lines.push(`- **Type:** ${a.type}`)
      lines.push(`- **Intent:** ${a.intent}`)
      lines.push(`- **Severity:** ${a.severity}`)
      lines.push(`- **Description:** ${a.description || '(none)'}`)
      if (a.type === 'region') {
        const g = a.geometry as { type: 'rect'; x: number; y: number; width: number; height: number }
        lines.push(`- **Geometry:** rect(x=${Math.round(g.x)}, y=${Math.round(g.y)}, w=${Math.round(g.width)}, h=${Math.round(g.height)})`)
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
