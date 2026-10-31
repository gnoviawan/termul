import type { AutomationId, RunId } from '@shared/types/automation.types'
import { useEffect, useState } from 'react'
import { ArrowLeft, Workflow } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { AutomationDetail } from './AutomationDetail'
import { AutomationList, AutomationListEmpty } from './AutomationList'
import { AutomationRunDetail } from './AutomationRunDetail'
import { useAutomationFocus } from './automation-focus'
import { SuggestedAutomations } from './SuggestedAutomations'
import { useAutomationDetail, useAutomationList, useAutomationRuns } from './use-automations'

interface AutomationsPanelProps {
  projectId: string
  isVisible: boolean
}

/**
 * The project's automations: a list beside the selected automation on
 * desktop, a list → detail → run stack on the phone shell.
 */
export function AutomationsPanel({
  projectId,
  isVisible
}: AutomationsPanelProps): React.JSX.Element {
  const phone = useMobileWebShell()
  const [chosenId, setSelectedId] = useState<AutomationId | null>(null)
  const [runId, setRunId] = useState<RunId | null>(null)
  const list = useAutomationList(projectId)
  // A choice deleted elsewhere (another device, an agent) counts as no choice.
  const chosen =
    list.data?.some((automation) => automation.id === chosenId) === false ? null : chosenId
  // Desktop shows the first automation until the user picks one.
  const selectedId = chosen ?? (phone ? null : (list.data?.[0]?.id ?? null))
  const detail = useAutomationDetail(selectedId)
  const runs = useAutomationRuns(selectedId)
  const run = runs.data?.find((candidate) => candidate.id === runId) ?? null

  const select = (id: AutomationId | null): void => {
    setSelectedId(id)
    setRunId(null)
  }
  const requested = useAutomationFocus((s) => s.requests[projectId])
  useEffect(() => {
    if (!requested) return
    setSelectedId(requested)
    setRunId(null)
    useAutomationFocus.getState().clear(projectId)
  }, [requested, projectId])
  const reloadAll = (): void => {
    list.reload()
    detail.reload()
    runs.reload()
  }

  const listView = (
    <>
      <SuggestedAutomations projectId={projectId} />
      {list.data === null ? (
        <PanelMessage
          text={list.error ? `Could not load automations: ${list.error}` : 'Loading…'}
        />
      ) : (
        <AutomationList automations={list.data} selectedId={selectedId} onSelect={select} />
      )}
    </>
  )

  const detailView =
    selectedId === null ? null : detail.data === null ? (
      <PanelMessage text={detail.error ? `Could not load it: ${detail.error}` : 'Loading…'} />
    ) : (
      <AutomationDetail
        detail={detail.data}
        runs={runs.data}
        narrow={phone}
        isVisible={isVisible && runId === null}
        onOpenRun={setRunId}
        onDeleted={() => select(null)}
        onChanged={reloadAll}
      />
    )

  const runView = run ? <AutomationRunDetail run={run} /> : null

  if (phone) {
    const level = runView ? 'run' : selectedId ? 'detail' : 'list'
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {level !== 'list' && (
          <div className="flex shrink-0 items-center border-b border-border px-1">
            <Button
              variant="ghost"
              size="touch"
              onClick={() => (level === 'run' ? setRunId(null) : select(null))}
            >
              <ArrowLeft size={16} />
              {level === 'run' ? 'Automation' : 'Automations'}
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {level === 'list' ? listView : <div className="p-4">{runView ?? detailView}</div>}
        </div>
      </div>
    )
  }

  if (list.data?.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto bg-background">
        <div className="w-full max-w-md">
          <SuggestedAutomations projectId={projectId} />
        </div>
        <AutomationListEmpty />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
          <Workflow size={14} className="text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">Automations</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{listView}</div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
          {runView ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setRunId(null)}
              >
                <ArrowLeft size={14} />
                Back to automation
              </Button>
              {runView}
            </>
          ) : (
            detailView
          )}
        </div>
      </main>
    </div>
  )
}

function PanelMessage({ text }: { text: string }): React.JSX.Element {
  return <p className="px-4 py-6 text-sm text-muted-foreground">{text}</p>
}
