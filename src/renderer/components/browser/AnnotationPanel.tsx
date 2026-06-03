import { Crosshair, FileDown, Square, StickyNote, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  type Annotation,
  type ElementGeometry,
  type Intent,
  normalizeUrl,
  type Severity,
  useAnnotationStore
} from '@/stores/annotation-store'
import type { AnnotationSubMode } from '@/stores/browser-session-store'

interface AnnotationPanelProps {
  url: string
  annotationSubMode: AnnotationSubMode
  annotationOverlayAvailable: boolean
  onExitAnnotationMode: () => void
  onChangeAnnotationSubMode: (mode: AnnotationSubMode) => void
  onAddNote: () => void
  onExport: () => void
}

const intentOptions: Intent[] = ['fix', 'change', 'question', 'approve']
const severityOptions: Severity[] = ['blocking', 'important', 'suggestion']

const severityColorClass: Record<Severity, string> = {
  blocking: 'bg-red-500',
  important: 'bg-amber-500',
  suggestion: 'bg-blue-500'
}

const intentBadgeClass: Record<Intent, string> = {
  fix: 'bg-red-100 text-red-700 border-red-200',
  change: 'bg-amber-100 text-amber-700 border-amber-200',
  question: 'bg-blue-100 text-blue-700 border-blue-200',
  approve: 'bg-green-100 text-green-700 border-green-200'
}

const selectorConfidenceClass: Record<ElementGeometry['selectorConfidence'], string> = {
  'unique-id': 'bg-green-100 text-green-800 border-green-200',
  'unique-class': 'bg-orange-100 text-orange-800 border-orange-200',
  fallback: 'bg-secondary text-secondary-foreground border-border'
}

function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

function AnnotationElementDetails({ geometry }: { geometry: ElementGeometry }): React.JSX.Element {
  const selectorPreview = truncateForDisplay(geometry.selector, 60)
  const textPreview = truncateForDisplay(geometry.textContent, 80) || '(no text)'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
          {`<${geometry.tagName}>`}
        </Badge>
        <Badge
          className={cn('text-[10px] border', selectorConfidenceClass[geometry.selectorConfidence])}
        >
          {geometry.selectorConfidence}
        </Badge>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="text-[11px] text-muted-foreground font-mono break-all cursor-default">
            {selectorPreview}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-md break-all text-xs font-mono">
          {geometry.selector}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="text-[11px] text-muted-foreground cursor-default whitespace-pre-wrap break-words">
            {textPreview}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-md whitespace-pre-wrap break-words text-xs">
          {geometry.textContent || '(no text)'}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function AnnotationItem({
  annotation,
  isSelected,
  onSelect,
  onUpdate,
  onDelete
}: {
  annotation: Annotation
  isSelected: boolean
  onSelect: () => void
  onUpdate: (
    id: string,
    updates: Partial<Pick<Annotation, 'intent' | 'severity' | 'description'>>
  ) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [draftDescription, setDraftDescription] = useState(annotation.description)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isSelected && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [isSelected])

  const handleSave = () => {
    onUpdate(annotation.id, { description: draftDescription })
    setIsEditing(false)
  }

  return (
    <div
      ref={cardRef}
      onClick={onSelect}
      className={cn(
        'rounded-md border border-border bg-card p-3 space-y-2 cursor-pointer',
        'motion-safe:transition-all motion-safe:duration-200',
        'hover:border-primary/50 hover:shadow-sm',
        isSelected && 'ring-2 ring-primary border-primary shadow-md shadow-primary/10'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold',
            intentBadgeClass[annotation.intent]
          )}
        >
          {annotation.intent}
        </span>
        <div
          className={cn('h-2 w-2 rounded-full', severityColorClass[annotation.severity])}
          title={annotation.severity}
        />
        <span className="text-[10px] text-muted-foreground capitalize">{annotation.severity}</span>
        <div className="flex-1" />
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete(annotation.id)
          }}
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          title="Delete annotation"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {annotation.type === 'region' && annotation.geometry.type === 'rect' && (
        <div className="text-[11px] text-muted-foreground font-mono">
          rect(
          {Math.round(annotation.geometry.x)}, {Math.round(annotation.geometry.y)},{' '}
          {Math.round(annotation.geometry.width)}, {Math.round(annotation.geometry.height)})
        </div>
      )}

      {annotation.type === 'element' && annotation.geometry.type === 'element' && (
        <AnnotationElementDetails geometry={annotation.geometry} />
      )}

      {isEditing ? (
        <div className="space-y-2">
          <Textarea
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            placeholder="Add a description..."
            className="min-h-[60px] text-xs"
          />
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                setDraftDescription(annotation.description)
                setIsEditing(false)
              }}
            >
              Cancel
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div
          onClick={(e) => {
            e.stopPropagation()
            setDraftDescription(annotation.description)
            setIsEditing(true)
          }}
          className="text-xs text-foreground cursor-text min-h-[1.5em] hover:bg-secondary/50 rounded px-1 -mx-1 transition-colors"
        >
          {annotation.description || (
            <span className="text-muted-foreground italic">Click to add description...</span>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Select
          value={annotation.intent}
          onValueChange={(v) => onUpdate(annotation.id, { intent: v as Intent })}
        >
          <SelectTrigger className="h-7 text-xs w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {intentOptions.map((opt) => (
              <SelectItem key={opt} value={opt} className="text-xs">
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={annotation.severity}
          onValueChange={(v) => onUpdate(annotation.id, { severity: v as Severity })}
        >
          <SelectTrigger className="h-7 text-xs w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {severityOptions.map((opt) => (
              <SelectItem key={opt} value={opt} className="text-xs">
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

export function AnnotationPanel({
  url,
  annotationSubMode,
  annotationOverlayAvailable,
  onExitAnnotationMode,
  onChangeAnnotationSubMode,
  onAddNote,
  onExport
}: AnnotationPanelProps): React.JSX.Element {
  const annotations = useAnnotationStore((state) => state.getAnnotationsForUrl(url))
  const removeAnnotation = useAnnotationStore((state) => state.removeAnnotation)
  const updateAnnotation = useAnnotationStore((state) => state.updateAnnotation)
  const setSelectedAnnotationId = useAnnotationStore((state) => state.setSelectedAnnotationId)
  const selectedAnnotationId = useAnnotationStore(
    (state) => state.selectedAnnotationIdByUrl.get(normalizeUrl(url)) ?? null
  )

  const normalizedUrl = normalizeUrl(url)
  const selectDisabled = !annotationOverlayAvailable
  const hasAnnotations = annotations.length > 0

  const handleToolbarKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = e.currentTarget.querySelectorAll('button:not([disabled])')
    const currentIndex = Array.from(buttons).findIndex((btn) => btn === document.activeElement)
    if (currentIndex === -1) return

    if (e.key === 'ArrowRight') {
      e.preventDefault()
      const next = buttons[(currentIndex + 1) % buttons.length] as HTMLElement
      next?.focus()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const prev = buttons[(currentIndex - 1 + buttons.length) % buttons.length] as HTMLElement
      prev?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      ;(buttons[0] as HTMLElement)?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      ;(buttons[buttons.length - 1] as HTMLElement)?.focus()
    }
  }, [])

  return (
    <div className="w-72 border-l border-border bg-background flex flex-col shrink-0 motion-safe:animate-slide-in">
      <div className="px-3 py-2 border-b border-border bg-card space-y-1.5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Annotations</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={onExitAnnotationMode}
                className="h-7 w-7 p-0"
                aria-label="Exit annotation mode"
              >
                <X size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Exit annotation mode</TooltipContent>
          </Tooltip>
        </div>

        <div
          role="toolbar"
          aria-label="Annotation tools"
          className="flex items-center gap-1"
          onKeyDown={handleToolbarKeyDown}
        >
          <div
            role="group"
            aria-label="Annotation mode"
            className="flex items-center rounded-md border border-border bg-background overflow-hidden"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={annotationSubMode === 'draw' ? 'default' : 'ghost'}
                  size="sm"
                  aria-pressed={annotationSubMode === 'draw'}
                  onClick={() => onChangeAnnotationSubMode('draw')}
                  className="h-7 w-7 p-0 motion-safe:transition-all motion-safe:duration-150"
                  aria-label="Draw rectangle annotations"
                >
                  <Square size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Draw rectangle</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={-1} className="outline-none">
                  <Button
                    type="button"
                    variant={annotationSubMode === 'select' ? 'default' : 'ghost'}
                    size="sm"
                    aria-pressed={annotationSubMode === 'select'}
                    onClick={() => onChangeAnnotationSubMode('select')}
                    disabled={selectDisabled}
                    className="h-7 w-7 p-0 motion-safe:transition-all motion-safe:duration-150"
                    aria-label={
                      selectDisabled ? 'Select unavailable on this page' : 'Select elements'
                    }
                  >
                    <Crosshair size={13} />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {selectDisabled ? 'Annotation unavailable on this page' : 'Select elements'}
              </TooltipContent>
            </Tooltip>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={onAddNote}
                className="h-7 w-7 p-0 motion-safe:transition-all motion-safe:duration-150 hover:bg-primary/10"
                aria-label="Add page note"
              >
                <StickyNote size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Add page note</TooltipContent>
          </Tooltip>

          <div className="flex-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={onExport}
                disabled={!hasAnnotations}
                className="h-7 w-7 p-0 motion-safe:transition-all motion-safe:duration-150 hover:bg-primary/10"
                aria-label={hasAnnotations ? 'Export annotations' : 'No annotations to export'}
              >
                <FileDown size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {hasAnnotations ? 'Export annotations' : 'No annotations to export'}
            </TooltipContent>
          </Tooltip>
        </div>

        <p className="text-[10px] text-muted-foreground">
          Session-scoped: annotations last until app close
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {annotations.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">
            No annotations on this page.
          </div>
        ) : (
          annotations.map((annotation) => (
            <AnnotationItem
              key={annotation.id}
              annotation={annotation}
              isSelected={selectedAnnotationId === annotation.id}
              onSelect={() => setSelectedAnnotationId(normalizedUrl, annotation.id)}
              onUpdate={(id, updates) => {
                updateAnnotation(normalizedUrl, id, updates)
              }}
              onDelete={(id) => {
                removeAnnotation(normalizedUrl, id)
              }}
            />
          ))
        )}
      </div>
    </div>
  )
}
