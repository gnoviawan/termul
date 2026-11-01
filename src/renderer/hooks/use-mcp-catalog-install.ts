import type {
  McpCatalogDefaultOption,
  McpCatalogReason,
  McpCatalogRow
} from '@shared/types/mcp-catalog.types'
import type { McpInstallForm, McpInstallPlan } from '@shared/types/mcp-install.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { initialInstallValues, splitInstallValues } from '@/components/settings/McpInstallForm'
import { oauthFailureMessage } from '@/components/settings/McpServersSettings'
import { type StoredMcpServer, transportOf } from '@/lib/acp-mcp-persistence'
import { logFrontendError } from '@/lib/log-api'
import { mcpCatalogApi } from '@/lib/mcp-catalog-api'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

export interface McpInstallTarget {
  name: string
  version: string
  title: string
  choice: McpCatalogDefaultOption
}

export type McpInstallFailure =
  | { kind: 'unsupported'; reason: McpCatalogReason }
  | { kind: 'host'; code: string }
  | { kind: 'save' }

export type McpInstallProbe =
  | { status: 'connected'; tools: number }
  | { status: 'disconnected'; error: string | null }
  | { status: 'sign-in-required' }

type Values = Record<string, string>

interface Filling {
  target: McpInstallTarget
  form: McpInstallForm
  values: Values
}

export type McpInstallFlow =
  | { step: 'idle' }
  | { step: 'describing'; target: McpInstallTarget }
  | (Filling & { step: 'form'; error: string | null; fieldErrors: Record<string, string> })
  | (Filling & { step: 'planning' })
  | (Filling & { step: 'consent'; plan: McpInstallPlan })
  | (Filling & { step: 'committing'; plan: McpInstallPlan })
  | { step: 'probing'; target: McpInstallTarget; server: StoredMcpServer }
  | { step: 'done'; target: McpInstallTarget; server: StoredMcpServer; probe: McpInstallProbe }
  | { step: 'failed'; target: McpInstallTarget; failure: McpInstallFailure }

export interface McpCatalogInstall {
  flow: McpInstallFlow
  start: (row: McpCatalogRow) => void
  change: (id: string, value: string) => void
  submit: () => void
  approve: () => void
  /** Starts OAuth from the click, so the web client may open the sign-in window. */
  signIn: () => void
  dismiss: () => void
  startOver: () => void
}

const IDLE: McpInstallFlow = { step: 'idle' }
const LOG_SOURCE = 'settings.McpCatalogInstall'

function hostFailure(code: string | undefined): McpInstallFailure {
  return { kind: 'host', code: code ?? 'unknown' }
}

function failureCode(failure: McpInstallFailure): string {
  switch (failure.kind) {
    case 'unsupported':
      return failure.reason.code
    case 'host':
      return failure.code
    case 'save':
      return 'save'
  }
}

function cancelPlan(planId: string): void {
  void mcpCatalogApi.cancelInstall({ planId }).then((result) => {
    if (!result.success) {
      void logFrontendError({
        level: 'warn',
        source: LOG_SOURCE,
        message: `cancel failed for plan ${planId.slice(0, 8)} (${result.code ?? 'unknown'})`
      })
    }
  })
}

function targetOf(row: McpCatalogRow, choice: McpCatalogDefaultOption): McpInstallTarget {
  return {
    name: row.name,
    version: row.version,
    title: row.title ?? row.name.slice(row.name.lastIndexOf('/') + 1),
    choice
  }
}

function probeSettled(id: string): Promise<void> {
  return new Promise((resolve) => {
    if (!useAcpStore.getState().mcpProbing[id]) return resolve()
    const unsubscribe = useAcpStore.subscribe((state) => {
      if (state.mcpProbing[id]) return
      unsubscribe()
      resolve()
    })
  })
}

async function probeInstalled(server: StoredMcpServer): Promise<McpInstallProbe> {
  await useAcpStore.getState().probeMcpServer(server.id)
  await probeSettled(server.id)
  const { mcpProbeStatus, mcpTools, mcpProbeError } = useAcpStore.getState()
  const status = mcpProbeStatus[server.id]
  if (status === 'connected') return { status, tools: mcpTools[server.id]?.length ?? 0 }
  if (status === 'authRequired' && transportOf(server) !== 'stdio') {
    return { status: 'sign-in-required' }
  }
  return { status: 'disconnected', error: mcpProbeError[server.id] ?? null }
}

export function useMcpCatalogInstall(): McpCatalogInstall {
  const [flow, setFlowState] = useState<McpInstallFlow>(IDLE)
  const current = useRef<McpInstallFlow>(IDLE)
  const flowGeneration = useRef(0)

  const setFlow = useCallback((next: McpInstallFlow) => {
    current.current = next
    setFlowState(next)
  }, [])

  const fail = useCallback(
    (target: McpInstallTarget, stage: string, failure: McpInstallFailure) => {
      void logFrontendError({
        level: 'warn',
        source: LOG_SOURCE,
        message: `${stage} failed for '${target.name}' ${target.version} (${failureCode(failure)})`
      })
      setFlow({ step: 'failed', target, failure })
    },
    [setFlow]
  )

  useEffect(
    () => () => {
      flowGeneration.current += 1
      const last = current.current
      if (last.step === 'consent') cancelPlan(last.plan.planId)
    },
    []
  )

  const plan = useCallback(
    async (filling: Filling) => {
      const token = flowGeneration.current
      const { target, form, values } = filling
      setFlow({ ...filling, step: 'planning' })
      const { inputs } = splitInstallValues(form.fields, values)
      const result = await mcpCatalogApi.planInstall({
        source: form.source,
        choice: target.choice,
        inputs
      })
      if (token !== flowGeneration.current) {
        if (result.success && result.data.outcome === 'plan') cancelPlan(result.data.plan.planId)
        return
      }
      if (!result.success && result.code === 'VALIDATION_ERROR') {
        setFlow({ ...filling, step: 'form', error: result.error ?? null, fieldErrors: {} })
      } else if (!result.success) {
        fail(target, 'plan', hostFailure(result.code))
      } else if (result.data.outcome === 'unsupported') {
        fail(target, 'plan', { kind: 'unsupported', reason: result.data.reason })
      } else {
        setFlow({ ...filling, step: 'consent', plan: result.data.plan })
      }
    },
    [fail, setFlow]
  )

  const describe = useCallback(
    async (target: McpInstallTarget) => {
      const token = ++flowGeneration.current
      setFlow({ step: 'describing', target })
      const result = await mcpCatalogApi.describeInstall({
        source: { kind: 'catalog', name: target.name, version: target.version },
        choice: target.choice
      })
      if (token !== flowGeneration.current) return
      if (!result.success) return fail(target, 'describe', hostFailure(result.code))
      if (result.data.outcome === 'unsupported') {
        return fail(target, 'describe', { kind: 'unsupported', reason: result.data.reason })
      }
      const { form } = result.data
      const filling = { target, form, values: initialInstallValues(form.fields) }
      if (form.fields.length === 0) await plan(filling)
      else setFlow({ ...filling, step: 'form', error: null, fieldErrors: {} })
    },
    [fail, plan, setFlow]
  )

  const start = useCallback(
    (row: McpCatalogRow) => {
      if (current.current.step !== 'idle' || row.defaultOption === null) return
      void describe(targetOf(row, row.defaultOption))
    },
    [describe]
  )

  const change = useCallback(
    (id: string, value: string) => {
      const state = current.current
      if (state.step !== 'form') return
      const { [id]: _cleared, ...fieldErrors } = state.fieldErrors
      setFlow({ ...state, values: { ...state.values, [id]: value }, fieldErrors })
    },
    [setFlow]
  )

  const submit = useCallback(() => {
    const state = current.current
    if (state.step !== 'form') return
    const fieldErrors = Object.fromEntries(
      state.form.fields
        .filter((field) => field.isRequired && (state.values[field.id] ?? '').trim() === '')
        .map((field) => [field.id, 'Fill this in to continue.'])
    )
    if (Object.keys(fieldErrors).length > 0) {
      setFlow({ ...state, error: null, fieldErrors })
      return
    }
    void plan(state)
  }, [plan, setFlow])

  const approve = useCallback(async () => {
    const state = current.current
    if (state.step !== 'consent') return
    const { target, form, values, plan: consented } = state
    setFlow({ ...state, step: 'committing' })
    const { secretValues } = splitInstallValues(form.fields, values)
    const committed = await mcpCatalogApi.commitInstall({
      planId: consented.planId,
      launchDigest: consented.launchDigest,
      secretValues
    })
    if (!committed.success) cancelPlan(consented.planId)
    if (!committed.success && committed.code === 'VALIDATION_ERROR') {
      setFlow({
        target,
        form,
        values,
        step: 'form',
        error: committed.error ?? null,
        fieldErrors: {}
      })
      return
    }
    if (!committed.success) return fail(target, 'commit', hostFailure(committed.code))
    let server: StoredMcpServer
    try {
      server = await useAcpStore.getState().saveCatalogInstall(committed.data)
    } catch {
      return fail(target, 'save', { kind: 'save' })
    }
    const token = flowGeneration.current
    setFlow({ step: 'probing', target, server })
    const probe = await probeInstalled(server)
    if (token === flowGeneration.current) setFlow({ step: 'done', target, server, probe })
  }, [fail, setFlow])

  const dismiss = useCallback(() => {
    const state = current.current
    if (state.step === 'committing') return
    flowGeneration.current += 1
    if (state.step === 'consent') cancelPlan(state.plan.planId)
    setFlow(IDLE)
  }, [setFlow])

  const signIn = useCallback(() => {
    const state = current.current
    if (state.step !== 'done') return
    const { server } = state
    void useAcpStore
      .getState()
      .connectMcpOAuth(useProjectStore.getState().activeProjectId, server.id)
      .then(() => toast.success(`Connected to ${server.name}`))
      .catch((error: unknown) => toast.error(oauthFailureMessage(error)))
  }, [])

  const startOver = useCallback(() => {
    const state = current.current
    if (state.step !== 'failed') return
    void describe(state.target)
  }, [describe])

  return {
    flow,
    start,
    change,
    submit,
    approve: () => void approve(),
    signIn,
    dismiss,
    startOver
  }
}
