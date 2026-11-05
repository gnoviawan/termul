import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { TabGlyph } from '../SelectorRows'
import { Busy, Note, SignInActions } from '../SignInActions'
import type { AgentTab } from '../selector-model'
import { type ProviderSetup, useProviderSetup } from './provider-setup'

/** The sheet route key of an agent's setup screen. */
export const setupRouteKey = (configId: string): string => `setup:${configId}`

function Hero({
  tab,
  title,
  detail
}: {
  tab: AgentTab
  title: string
  detail?: string
}): React.JSX.Element {
  return (
    <div role="status" className="flex flex-col items-center gap-1 px-4 pb-2 pt-3 text-center">
      <span className="mb-2 flex size-14 items-center justify-center rounded-2xl bg-foreground/[0.08] [&>span]:scale-[2]">
        <TabGlyph tab={tab} />
      </span>
      <h3 className="text-lg font-semibold text-foreground">{title}</h3>
      {detail ? (
        <p className="line-clamp-4 break-words text-sm text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  )
}

/**
 * An agent the chat cannot use yet, set up in place: save its config, start
 * it, and sign in when it asks. The sheet returns to its models once they load.
 */
export function ProviderSetupScreen({
  tab,
  workspace,
  disabled,
  onReady
}: {
  tab: AgentTab
  workspace: { cwd: string; projectId: string }
  disabled: boolean
  /** Its models are known: show them. */
  onReady: () => void
}): React.JSX.Element {
  const setup = useProviderSetup(tab, workspace)
  const ready = setup.phase.kind === 'ready'
  const left = useRef(false)
  useEffect(() => {
    if (!ready || left.current) return
    left.current = true
    onReady()
  }, [ready, onReady])
  return <ProviderSetupView tab={tab} setup={setup} disabled={disabled} />
}

function ProviderSetupView({
  tab,
  setup,
  disabled
}: {
  tab: AgentTab
  setup: ProviderSetup
  disabled: boolean
}): React.JSX.Element {
  const { phase } = setup
  let hero: ReactNode
  let actions: ReactNode
  switch (phase.kind) {
    case 'confirm':
      hero = (
        <Hero
          tab={tab}
          title={`Set up ${tab.name}`}
          detail="Add it to this server's agents, then pick a model."
        />
      )
      actions = (
        <>
          <Button
            type="button"
            size="touch"
            className="w-full"
            disabled={disabled || !setup.config}
            onClick={setup.start}
          >
            {`Set up ${tab.name}`}
          </Button>
          {setup.config ? <Note>{`Runs with ${setup.config.command} on this server.`}</Note> : null}
        </>
      )
      break
    case 'saving':
      hero = <Hero tab={tab} title={`Set up ${tab.name}`} />
      actions = <Busy label="Setting up…" touch />
      break
    case 'starting':
    case 'ready':
      hero = <Hero tab={tab} title={`Starting ${tab.name}`} detail="Reading its models." />
      actions = <Busy label="Starting…" touch />
      break
    case 'sign-in':
      hero = <Hero tab={tab} title={`Sign in to ${tab.name}`} detail={phase.error.detail} />
      actions = (
        <SignInActions
          tab={tab}
          signIn={setup.signIn}
          retry={setup.retry}
          disabled={disabled}
          touch
        />
      )
      break
    case 'failed':
      hero = <Hero tab={tab} title={phase.title} detail={phase.detail} />
      actions = (
        <Button
          type="button"
          size="touch"
          className="w-full"
          disabled={disabled}
          onClick={setup.retry}
        >
          Try again
        </Button>
      )
      break
  }
  return (
    <div data-testid="provider-setup" data-phase={phase.kind} className="flex flex-col gap-3 pb-2">
      {hero}
      <div className="flex flex-col gap-2 px-1">{actions}</div>
    </div>
  )
}
