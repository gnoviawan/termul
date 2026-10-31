import type {
  GithubItemDetail,
  GithubMergeAction,
  GithubMergeMethod,
  GithubPullDetail
} from '@shared/types/github.types'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { WriteGate } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { type GithubItemRef, useGithubStore } from '@/stores/github-store'

const METHODS: ReadonlyArray<{ value: GithubMergeMethod; label: string; verb: string }> = [
  { value: 'merge', label: 'Merge commit', verb: 'Merge' },
  { value: 'squash', label: 'Squash and merge', verb: 'Squash and merge' },
  { value: 'rebase', label: 'Rebase and merge', verb: 'Rebase and merge' }
]

/** `mergeStateStatus` values GitHub merges right away. */
const MERGEABLE_NOW = new Set(['CLEAN', 'HAS_HOOKS'])

/** Why the Merge button is off, per GitHub `mergeStateStatus`. */
const BLOCKED_REASON: Record<string, string> = {
  BLOCKED: 'Merging is blocked by required reviews or checks.',
  BEHIND: 'The branch is behind its base branch.',
  DIRTY: 'The branch has conflicts with its base branch.',
  UNSTABLE: 'Some checks are not passing.',
  DRAFT: 'Draft pull requests cannot be merged.',
  UNKNOWN: 'GitHub is still checking whether this can merge.'
}

const SUCCESS_MESSAGE: Record<GithubMergeAction['kind'], string> = {
  merge: 'Merge requested on GitHub',
  enable_auto_merge: 'Auto-merge enabled',
  disable_auto_merge: 'Auto-merge disabled'
}

interface GithubMergeControlsProps {
  itemRef: GithubItemRef
  detail: GithubItemDetail
  pr: GithubPullDetail
}

/**
 * CAP-4 merge box. Merge is enabled only for an open PR GitHub reports as
 * CLEAN or HAS_HOOKS, and asks first. The state shown after an action is what
 * GitHub reports on the re-read, never a local guess. Read-only servers gate
 * every control through `WriteGate`.
 */
export function GithubMergeControls({
  itemRef,
  detail,
  pr
}: GithubMergeControlsProps): React.JSX.Element | null {
  const admitted = useServerAdmitsRemoteWrites()
  const [method, setMethod] = useState<GithubMergeMethod>('merge')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const state = detail.item.state
  if (state === 'merged' || state === 'closed') return null

  const canMerge = state === 'open' && MERGEABLE_NOW.has(pr.mergeStateStatus)
  const reason = canMerge
    ? null
    : (BLOCKED_REASON[pr.mergeStateStatus] ?? `GitHub reports ${pr.mergeStateStatus}.`)
  const verb = METHODS.find((m) => m.value === method)?.verb ?? 'Merge'
  const gated = !admitted
  // Auto-merge is for a PR that cannot merge yet; once on, it can be turned off.
  const autoMergeAction: GithubMergeAction | null = pr.autoMergeEnabled
    ? { kind: 'disable_auto_merge' }
    : state === 'open' && !canMerge
      ? { kind: 'enable_auto_merge', method }
      : null

  const run = async (action: GithubMergeAction): Promise<void> => {
    setBusy(true)
    const result = await useGithubStore.getState().merge(itemRef, action)
    setBusy(false)
    if (result.success) {
      toast.success(SUCCESS_MESSAGE[action.kind])
    } else {
      toast.error(
        result.code === 'GH_NOT_MERGEABLE' ? 'GitHub refused the merge' : 'Merge action failed',
        { description: result.error }
      )
    }
  }

  return (
    <section
      aria-labelledby="github-merge"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <h2 id="github-merge" className="text-sm font-medium text-foreground">
        Merge
      </h2>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      {pr.autoMergeEnabled && (
        <p className="text-xs text-foreground">
          Auto-merge is on: GitHub merges this when its requirements pass.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <WriteGate gated={gated}>
          <Select
            value={method}
            onValueChange={(value) => setMethod(value as GithubMergeMethod)}
            disabled={gated || busy}
          >
            <SelectTrigger aria-label="Merge method" className="h-9 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </WriteGate>
        <WriteGate gated={gated}>
          <Button
            size="sm"
            disabled={gated || busy || !canMerge}
            onClick={() => setConfirming(true)}
          >
            {verb}
          </Button>
        </WriteGate>
        {autoMergeAction && (
          <WriteGate gated={gated}>
            <Button
              variant="outline"
              size="sm"
              disabled={gated || busy}
              onClick={() => void run(autoMergeAction)}
            >
              {autoMergeAction.kind === 'disable_auto_merge'
                ? 'Disable auto-merge'
                : 'Enable auto-merge'}
            </Button>
          </WriteGate>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirming}
        title={`${verb} pull request #${detail.item.number}?`}
        message={`${verb} ${pr.headRefName} into ${pr.baseRefName} on GitHub.`}
        confirmLabel={verb}
        isLoading={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void run({ kind: 'merge', method })
        }}
      />
    </section>
  )
}
