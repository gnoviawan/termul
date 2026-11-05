import type { McpInstallField, McpInstallFieldTarget } from '@shared/types/mcp-install.types'
import { useId } from 'react'
import { FolderOpen } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { dialogApi } from '@/lib/dialog-api'
import { logFrontendError } from '@/lib/log-api'

const FIELD_GROUPS: ReadonlyArray<{ kind: McpInstallFieldTarget['kind']; heading: string }> = [
  { kind: 'env', heading: 'Environment' },
  { kind: 'header', heading: 'Headers' },
  { kind: 'argument', heading: 'Arguments' },
  { kind: 'url', heading: 'URL' }
]

type ControlKind = 'secret' | 'choice' | 'boolean' | 'number' | 'filepath' | 'text'

function controlKind(field: McpInstallField): ControlKind {
  if (field.isSecret) return 'secret'
  if (field.choices !== null) return 'choice'
  if (field.format === 'string') return 'text'
  return field.format
}

export function initialInstallValues(fields: McpInstallField[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [
      field.id,
      field.format === 'boolean'
        ? String(field.default?.trim().toLowerCase() === 'true')
        : (field.default ?? '')
    ])
  )
}

export function splitInstallValues(
  fields: McpInstallField[],
  values: Record<string, string>
): { inputs: Record<string, string>; secretValues: Record<string, string> } {
  const inputs: Record<string, string> = {}
  const secretValues: Record<string, string> = {}
  for (const field of fields) {
    const bucket = field.isSecret ? secretValues : inputs
    bucket[field.id] = values[field.id] ?? ''
  }
  return { inputs, secretValues }
}

interface McpInstallFormProps {
  fields: McpInstallField[]
  values: Record<string, string>
  onChange: (id: string, value: string) => void
  disabled?: boolean
  errors?: Record<string, string>
}

export function McpInstallForm({
  fields,
  values,
  onChange,
  disabled = false,
  errors = {}
}: McpInstallFormProps): React.JSX.Element {
  const idPrefix = useId()
  const indexed = fields.map((field, index) => ({ field, controlId: `${idPrefix}-${index}` }))

  return (
    <div className="grid gap-5">
      {FIELD_GROUPS.map(({ kind, heading }) => {
        const group = indexed.filter(({ field }) => field.target.kind === kind)
        if (group.length === 0) return null
        return (
          <fieldset key={kind} className="grid gap-3">
            <legend className="label-panel mb-2">{heading}</legend>
            {group.map(({ field, controlId }) => (
              <InstallField
                key={field.id}
                field={field}
                controlId={controlId}
                value={values[field.id] ?? ''}
                onChange={(value) => onChange(field.id, value)}
                disabled={disabled}
                error={errors[field.id]}
              />
            ))}
          </fieldset>
        )
      })}
    </div>
  )
}

interface InstallFieldProps {
  field: McpInstallField
  controlId: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  error: string | undefined
}

function InstallField({
  field,
  controlId,
  value,
  onChange,
  disabled,
  error
}: InstallFieldProps): React.JSX.Element {
  const descriptionId = `${controlId}-description`
  const errorId = `${controlId}-error`
  const describedBy =
    [field.description !== null && descriptionId, error !== undefined && errorId]
      .filter(Boolean)
      .join(' ') || undefined
  const kind = controlKind(field)

  const shared = {
    id: controlId,
    disabled,
    'aria-describedby': describedBy,
    'aria-invalid': error !== undefined,
    'aria-required': field.isRequired
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={controlId} className="text-xs">
        {field.label}
        {field.isRequired && (
          <span aria-hidden="true" className="ml-0.5 text-muted-foreground">
            *
          </span>
        )}
      </Label>
      {kind === 'boolean' ? (
        <Switch
          {...shared}
          checked={value === 'true'}
          onCheckedChange={(checked) => onChange(String(checked))}
        />
      ) : kind === 'choice' ? (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger {...shared} className="h-9">
            <SelectValue placeholder={field.placeholder ?? 'Choose a value'} />
          </SelectTrigger>
          <SelectContent>
            {(field.choices ?? []).map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : kind === 'filepath' ? (
        <div className="flex gap-2">
          <Input
            {...shared}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? undefined}
            spellCheck={false}
            className="h-9 font-mono text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void browseHostPath(onChange)}
          >
            <FolderOpen />
            Browse
          </Button>
        </div>
      ) : (
        <Input
          {...shared}
          type={kind === 'secret' ? 'password' : kind === 'number' ? 'number' : 'text'}
          inputMode={kind === 'number' ? 'numeric' : undefined}
          autoComplete={kind === 'secret' ? 'off' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? undefined}
          spellCheck={false}
          className="h-9 text-sm"
        />
      )}
      {field.description !== null && (
        <p id={descriptionId} className="text-2xs text-muted-foreground">
          {field.description}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

async function browseHostPath(onChange: (value: string) => void): Promise<void> {
  const result = await dialogApi.selectDirectory()
  if (result.success) {
    onChange(result.data)
  } else if (result.code !== 'CANCELLED') {
    void logFrontendError({
      level: 'warn',
      source: 'McpInstallForm:browse',
      message: `Host path picker failed: ${result.code}`
    })
  }
}
