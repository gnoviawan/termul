import { type ReactNode, useEffect, useRef, useState } from 'react'
import { partitionAuthMethods } from '@/components/agents/launcher/auth-methods'
import { FactoryApiKeyForm } from '@/components/agents/launcher/FactoryApiKeyForm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import type { AuthMethod } from '@/lib/acp-api'
import { TabGlyph } from '../SelectorRows'
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

function Note({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="px-4 text-center text-xs text-muted-foreground">{children}</p>
}

function Busy({ label }: { label: string }): React.JSX.Element {
  return (
    <Button type="button" size="touch" className="w-full" disabled>
      <Spinner size={14} decorative className="mr-1.5" />
      {label}
    </Button>
  )
}

/** Agent-run methods first: they finish in place; a terminal opens a tab. */
const byInPlaceFirst = (a: AuthMethod, b: AuthMethod): number =>
  Number(a.type === 'terminal') - Number(b.type === 'terminal')

function SignInActions({
  tab,
  setup,
  disabled
}: {
  tab: AgentTab
  setup: ProviderSetup
  disabled: boolean
}): React.JSX.Element {
  const { signIn } = setup
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [gatewayKey, setGatewayKey] = useState('')
  const { runnable, gateway, guidance } = partitionAuthMethods(signIn.authMethods)
  const methods = [...runnable].sort(byInPlaceFirst)
  const signingIn = signIn.authMethods.find((m) => m.id === signIn.signingInMethodId)

  if (signingIn) return <Busy label={`Signing in with ${signingIn.name}…`} />
  if (signIn.factoryKeyAuth.showKeyInput && signIn.inlineKeyMethodId) {
    return <FactoryApiKeyForm auth={signIn.factoryKeyAuth} />
  }
  return (
    <>
      {methods.map((method, index) => (
        <Button
          key={method.id}
          type="button"
          size="touch"
          variant={index === 0 ? 'default' : 'secondary'}
          className="w-full"
          disabled={disabled}
          onClick={() => signIn.handleAuthMethod(method)}
        >
          {method.name}
        </Button>
      ))}
      {gateway ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void signIn.runAuthenticate(gateway.id, {
              baseUrl: gatewayUrl.trim(),
              ...(gatewayKey.trim() ? { apiKey: gatewayKey.trim() } : {})
            })
          }}
        >
          <Input
            value={gatewayUrl}
            onChange={(event) => setGatewayUrl(event.target.value)}
            placeholder="Gateway base URL"
            aria-label="Gateway base URL"
          />
          <Input
            value={gatewayKey}
            onChange={(event) => setGatewayKey(event.target.value)}
            placeholder="API key (optional)"
            aria-label="Gateway API key"
            type="password"
          />
          <Button
            type="submit"
            size="touch"
            variant={methods.length === 0 ? 'default' : 'secondary'}
            className="w-full"
            disabled={disabled || !gatewayUrl.trim()}
          >
            {gateway.name}
          </Button>
        </form>
      ) : null}
      {methods.length === 0 && !gateway ? (
        <Button type="button" size="touch" className="w-full" onClick={setup.retry}>
          Try again
        </Button>
      ) : null}
      {guidance.map((method) =>
        method.description?.trim() ? <Note key={method.id}>{method.description.trim()}</Note> : null
      )}
      {methods[0] ? (
        <Note>
          {methods[0].type === 'terminal'
            ? 'Opens a sign-in terminal on this server.'
            : `${tab.name} opens its sign-in page. Come back here when you are done.`}
        </Note>
      ) : null}
    </>
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
      actions = <Busy label="Setting up…" />
      break
    case 'starting':
    case 'ready':
      hero = <Hero tab={tab} title={`Starting ${tab.name}`} detail="Reading its models." />
      actions = <Busy label="Starting…" />
      break
    case 'sign-in':
      hero = <Hero tab={tab} title={`Sign in to ${tab.name}`} detail={phase.error.detail} />
      actions = <SignInActions tab={tab} setup={setup} disabled={disabled} />
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
