import {
  Calendar,
  CircleDot,
  type FileText,
  FolderOpen,
  GitCommitHorizontal,
  Hash,
  List,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  Type,
  X
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  type FrontmatterMap,
  type FrontmatterValue,
  formatFrontmatterValue,
  isFrontmatterNested,
  parseScalarInput
} from '@/lib/markdown-frontmatter'
import { cn } from '@/lib/utils'

interface FrontmatterPropertiesProps {
  data: FrontmatterMap
  onChange: (next: FrontmatterMap) => void
}

const KEY_ICONS: Record<string, typeof FileText> = {
  title: Type,
  type: Tag,
  created: Calendar,
  status: CircleDot,
  context: FolderOpen,
  baseline_commit: GitCommitHorizontal,
  review_loop_iteration: RefreshCw
}

function iconForKey(key: string): typeof FileText {
  return KEY_ICONS[key] ?? Hash
}

export function FrontmatterProperties({
  data,
  onChange
}: FrontmatterPropertiesProps): React.JSX.Element {
  const baseId = useId()
  const dataRef = useRef(data)
  dataRef.current = data

  const [adding, setAdding] = useState(false)
  const [draftKey, setDraftKey] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  /** In-progress scalar text while an input is focused (keyed by property name). */
  const [draftScalars, setDraftScalars] = useState<Record<string, string>>({})

  useEffect(() => {
    setDraftScalars((prev) => {
      const next: Record<string, string> = {}
      for (const key of Object.keys(prev)) {
        if (Object.hasOwn(data, key)) {
          next[key] = prev[key]
        }
      }
      return next
    })
  }, [data])

  const entries = Object.entries(data)

  const updateKey = useCallback(
    (key: string, value: FrontmatterValue) => {
      onChange({ ...dataRef.current, [key]: value })
    },
    [onChange]
  )

  const removeKey = useCallback(
    (key: string) => {
      const next = { ...dataRef.current }
      delete next[key]
      onChange(next)
    },
    [onChange]
  )

  const removeArrayItem = useCallback(
    (key: string, index: number) => {
      const current = dataRef.current[key]
      if (!Array.isArray(current)) return
      const next = current.filter((_, i) => i !== index)
      onChange({ ...dataRef.current, [key]: next })
    },
    [onChange]
  )

  const commitAdd = useCallback(() => {
    const key = draftKey.trim()
    if (!key) {
      setDraftError('Key cannot be empty')
      return
    }
    if (Object.hasOwn(dataRef.current, key)) {
      setDraftError('Key already exists')
      return
    }
    onChange({ ...dataRef.current, [key]: '' })
    setDraftKey('')
    setDraftError(null)
    setAdding(false)
  }, [draftKey, onChange])

  const cancelAdd = useCallback(() => {
    setAdding(false)
    setDraftKey('')
    setDraftError(null)
  }, [])

  const commitScalar = useCallback(
    (key: string) => {
      const draft = draftScalars[key]
      if (draft === undefined) return
      updateKey(key, parseScalarInput(draft))
      setDraftScalars((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    },
    [draftScalars, updateKey]
  )

  return (
    <div className="border-b border-border bg-muted/20 px-4 py-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Properties
      </div>

      <div className="flex flex-col gap-1.5">
        {entries.map(([key, value]) => {
          const Icon = iconForKey(key)
          return (
            <div key={key} className="group flex items-start gap-2 rounded-md px-1 py-1">
              <Icon className="mt-2 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <label
                htmlFor={`${baseId}-${key}`}
                className="mt-1.5 w-28 shrink-0 truncate text-xs text-muted-foreground"
                title={key}
              >
                {key}
              </label>
              <div className="min-w-0 flex-1">
                {isFrontmatterNested(value) ? (
                  <div
                    id={`${baseId}-${key}`}
                    className="rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 font-mono text-xs text-muted-foreground"
                    title="Nested value (read-only)"
                  >
                    {value.display}
                  </div>
                ) : Array.isArray(value) ? (
                  <div className="flex flex-wrap items-center gap-1.5 py-0.5">
                    {value.map((item, index) => (
                      <Badge
                        key={`${key}-${item}-${index}`}
                        variant="secondary"
                        className="gap-1 pr-1 font-normal"
                      >
                        <List className="size-3 opacity-60" aria-hidden="true" />
                        <span>{item}</span>
                        <button
                          type="button"
                          className="rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Remove ${item}`}
                          onClick={() => removeArrayItem(key, index)}
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    ))}
                    {value.length === 0 && (
                      <span className="text-xs text-muted-foreground">[]</span>
                    )}
                  </div>
                ) : (
                  <Input
                    id={`${baseId}-${key}`}
                    className="h-8 border-transparent bg-transparent px-2 shadow-none hover:border-input focus-visible:border-input"
                    value={
                      draftScalars[key] !== undefined
                        ? draftScalars[key]
                        : formatFrontmatterValue(value)
                    }
                    onFocus={() => {
                      setDraftScalars((prev) => ({
                        ...prev,
                        [key]: formatFrontmatterValue(value)
                      }))
                    }}
                    onChange={(event) => {
                      const nextText = event.target.value
                      setDraftScalars((prev) => ({ ...prev, [key]: nextText }))
                    }}
                    onBlur={() => commitScalar(key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur()
                      }
                    }}
                  />
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn(
                  'mt-1 shrink-0 text-muted-foreground transition-opacity',
                  // Touch / no-hover: always visible. Fine pointer: reveal on row hover/focus.
                  'opacity-50 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100',
                  'focus-visible:opacity-100'
                )}
                aria-label={`Remove ${key}`}
                onClick={() => removeKey(key)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )
        })}
      </div>

      {adding ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              className="h-8"
              placeholder="Property key"
              value={draftKey}
              autoFocus
              aria-invalid={draftError !== null}
              onChange={(event) => {
                setDraftKey(event.target.value)
                setDraftError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitAdd()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelAdd()
                }
              }}
            />
            <Button type="button" size="xs" onClick={commitAdd}>
              Add
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={cancelAdd}>
              Cancel
            </Button>
          </div>
          {draftError && <p className="text-xs text-destructive">{draftError}</p>}
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-2 text-muted-foreground"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" />
          Add property
        </Button>
      )}
    </div>
  )
}
