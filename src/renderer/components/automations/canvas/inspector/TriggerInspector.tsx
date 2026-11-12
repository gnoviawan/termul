import type { Issue, Schedule, Trigger } from '@shared/types/automation.types'
import { useEffect, useState } from 'react'
import { Clock, Zap } from '@/components/icons'
import { previewSchedule } from '@/lib/automation-api'
import { cn } from '@/lib/utils'
import { formatDateTime } from '../../automation-format'
import { SAVING_MESSAGE } from '../draft/use-draft'
import { ChoiceField, DurationField, TextField } from './fields'
import { InspectorPanel } from './NodeInspector'

/** Waits for typing to settle before asking the host for the next runs. */
const PREVIEW_DELAY_MS = 300
const MINUTE_MS = 60_000

const startOfMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS

/** A fresh schedule of `kind`: weekday mornings here, hourly from now, or in an hour. */
function newSchedule(kind: Schedule['kind']): Schedule {
  const now = startOfMinute(Date.now())
  switch (kind) {
    case 'cron':
      return {
        kind: 'cron',
        expr: '0 9 * * 1-5',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    case 'every':
      return { kind: 'every', every_ms: 3_600_000, anchor_ms: now }
    case 'at':
      return { kind: 'at', at: now + 3_600_000 }
  }
}

/** `ms` as a `datetime-local` value in local time. */
function localInput(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The next runs the host computes for `schedule`, asked once typing settles. */
function NextRuns({ schedule }: { schedule: Schedule }): React.JSX.Element {
  const key = JSON.stringify(schedule)
  const [preview, setPreview] = useState<{ key: string; runs: number[]; error: string | null }>()
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      void previewSchedule(JSON.parse(key) as Schedule).then((result) => {
        if (!current) return
        setPreview(
          result.success
            ? { key, runs: result.data.next_runs, error: result.data.error }
            : { key, runs: [], error: result.error }
        )
      })
    }, PREVIEW_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [key])
  const stale = preview?.key !== key
  return (
    <section aria-label="Next runs" aria-busy={stale} className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium">Next runs</h4>
      {preview === undefined ? (
        <p className="text-xs text-muted-foreground">Checking…</p>
      ) : preview.error ? (
        <p className={cn('text-xs text-destructive', stale && 'opacity-60')}>{preview.error}</p>
      ) : preview.runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs ahead.</p>
      ) : (
        <ul className={cn('flex flex-col gap-0.5 text-xs tabular-nums', stale && 'opacity-60')}>
          {preview.runs.map((at) => (
            <li key={at}>{formatDateTime(at)}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CronFields({
  schedule,
  commit
}: {
  schedule: Extract<Schedule, { kind: 'cron' }>
  commit: (schedule: Schedule) => boolean
}): React.JSX.Element {
  const [expr, setExpr] = useState(schedule.expr)
  const [timezone, setTimezone] = useState(schedule.timezone)
  return (
    <>
      <TextField
        id="inspect-trigger-cron"
        label="Cron expression"
        value={schedule.expr}
        help="Minute, hour, day of month, month, day of week."
        mono
        onText={setExpr}
        commit={(text) => {
          return commit({ ...schedule, expr: text.trim() }) ? null : SAVING_MESSAGE
        }}
      />
      <TextField
        id="inspect-trigger-timezone"
        label="Time zone"
        value={schedule.timezone}
        placeholder="Europe/Berlin"
        onText={setTimezone}
        commit={(text) => {
          return commit({ ...schedule, timezone: text.trim() }) ? null : SAVING_MESSAGE
        }}
      />
      <NextRuns schedule={{ kind: 'cron', expr: expr.trim(), timezone: timezone.trim() }} />
    </>
  )
}

const RUNS = [
  { value: 'manual', label: 'When you run it' },
  { value: 'schedule', label: 'On a schedule' }
] as const

const SCHEDULE_KINDS = [
  { value: 'cron', label: 'Cron' },
  { value: 'every', label: 'Every interval' },
  { value: 'at', label: 'Once' }
] as const

/** The trigger card's inspector: run by hand, or on a schedule with its next runs. */
export function TriggerInspector({
  trigger,
  issues,
  phone,
  locked,
  onChange,
  onClose
}: {
  trigger: Trigger
  /** Issues on no step: the schedule, the trigger's edge. */
  issues: readonly Issue[]
  phone: boolean
  locked: boolean
  /** False when the draft did not take the edit. */
  onChange: (trigger: Trigger) => boolean
  onClose: () => void
}): React.JSX.Element {
  const schedule = trigger.kind === 'schedule' ? trigger.schedule : null
  const commit = (next: Schedule): boolean =>
    JSON.stringify(next) === JSON.stringify(schedule) ||
    onChange({ kind: 'schedule', schedule: next })
  return (
    <InspectorPanel
      phone={phone}
      Icon={schedule ? Clock : Zap}
      title="Trigger"
      kind={schedule ? 'Schedule' : 'Manual'}
      id="trigger"
      issues={issues}
      onClose={onClose}
    >
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3">
        <ChoiceField
          id="inspect-trigger-kind"
          label="Runs"
          value={trigger.kind}
          options={RUNS}
          onChange={(kind) =>
            onChange(
              kind === 'manual'
                ? { kind: 'manual' }
                : { kind: 'schedule', schedule: newSchedule('cron') }
            )
          }
        />
        {schedule && (
          <ChoiceField
            id="inspect-trigger-schedule"
            label="Schedule"
            value={schedule.kind}
            options={SCHEDULE_KINDS}
            onChange={(kind) => commit(newSchedule(kind))}
          />
        )}
        {schedule?.kind === 'cron' && <CronFields schedule={schedule} commit={commit} />}
        {schedule?.kind === 'every' && (
          <>
            <DurationField
              id="inspect-trigger-every"
              label="Every"
              value={schedule.every_ms}
              commit={(every_ms) => commit({ ...schedule, every_ms })}
            />
            <NextRuns schedule={schedule} />
          </>
        )}
        {schedule?.kind === 'at' && (
          <>
            <TextField
              id="inspect-trigger-at"
              label="Run at"
              type="datetime-local"
              value={localInput(schedule.at)}
              commit={(text) => {
                const at = new Date(text).getTime()
                if (Number.isNaN(at)) return 'Enter a date and time'
                return commit({ kind: 'at', at }) ? null : SAVING_MESSAGE
              }}
            />
            <NextRuns schedule={schedule} />
          </>
        )}
      </fieldset>
    </InspectorPanel>
  )
}
