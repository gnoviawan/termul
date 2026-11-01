import { type ReactNode, useState } from 'react'
import { ApiKeyForm } from '@/components/agents/launcher/ApiKeyForm'
import { partitionAuthMethods } from '@/components/agents/launcher/auth-methods'
import { FactoryApiKeyForm } from '@/components/agents/launcher/FactoryApiKeyForm'
import type { AgentSignIn } from '@/components/agents/launcher/use-agent-sign-in'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import type { AuthMethod } from '@/lib/acp-api'
import type { AgentTab } from './selector-model'
import { useSelectorAgentSignIn } from './use-selector-agent-sign-in'

export function Note({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="px-4 text-center text-xs text-muted-foreground">{children}</p>
}

export function Busy({ label, touch }: { label: string; touch: boolean }): React.JSX.Element {
  return (
    <Button type="button" size={touch ? 'touch' : 'sm'} className="w-full" disabled>
      <Spinner size={14} decorative className="mr-1.5" />
      {label}
    </Button>
  )
}

/** Agent-run methods first: they finish in place; a terminal opens a tab. */
const byInPlaceFirst = (a: AuthMethod, b: AuthMethod): number =>
  Number(a.type === 'terminal') - Number(b.type === 'terminal')

/**
 * An agent's advertised sign-in methods as buttons: agent and terminal
 * methods run through `handleAuthMethod`, API-key methods and the gateway
 * method take their key or URL here, the inline-key method shows its key
 * form, and the rest are notes.
 */
export function SignInActions({
  tab,
  signIn,
  retry,
  disabled,
  touch
}: {
  tab: AgentTab
  signIn: AgentSignIn
  retry: () => void
  disabled: boolean
  touch: boolean
}): React.JSX.Element {
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [gatewayKey, setGatewayKey] = useState('')
  const { runnable, apiKey, gateway, guidance } = partitionAuthMethods(signIn.authMethods)
  const methods = [...runnable].sort(byInPlaceFirst)
  const signingIn = signIn.authMethods.find((m) => m.id === signIn.signingInMethodId)
  const size = touch ? 'touch' : 'sm'

  if (signingIn) return <Busy label={`Signing in with ${signingIn.name}…`} touch={touch} />
  if (signIn.factoryKeyAuth.showKeyInput && signIn.inlineKeyMethodId) {
    return <FactoryApiKeyForm auth={signIn.factoryKeyAuth} />
  }
  return (
    <>
      {methods.map((method, index) => (
        <Button
          key={method.id}
          type="button"
          size={size}
          variant={index === 0 ? 'default' : 'secondary'}
          className="w-full"
          disabled={disabled}
          onClick={() => signIn.handleAuthMethod(method)}
        >
          {method.name}
        </Button>
      ))}
      {apiKey.map((method, index) => (
        <ApiKeyForm
          key={method.id}
          method={method}
          layout="stack"
          size={size}
          variant={methods.length === 0 && index === 0 ? 'default' : 'secondary'}
          disabled={disabled}
          onSubmit={(key) =>
            key
              ? void signIn.runAuthenticate(method.id, { apiKey: key })
              : signIn.handleAuthMethod(method)
          }
        />
      ))}
      {gateway ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void signIn.runAuthenticate(gateway.id, {
              gateway: {
                baseUrl: gatewayUrl.trim(),
                ...(gatewayKey.trim() ? { apiKey: gatewayKey.trim() } : {})
              }
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
            size={size}
            variant={methods.length === 0 && apiKey.length === 0 ? 'default' : 'secondary'}
            className="w-full"
            disabled={disabled || !gatewayUrl.trim()}
          >
            {gateway.name}
          </Button>
        </form>
      ) : null}
      {methods.length === 0 && apiKey.length === 0 && !gateway ? (
        <Button type="button" size={size} className="w-full" onClick={retry}>
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
 * The desktop panels' sign-in for another tab's agent whose model read asked
 * for credentials. A successful sign-in reads its models again (`retry`).
 */
export function OtherAgentSignIn({
  tab,
  workspace,
  retry,
  disabled,
  touch
}: {
  tab: AgentTab
  workspace: { cwd: string; projectId: string }
  retry: () => void
  disabled: boolean
  touch: boolean
}): React.JSX.Element {
  const signIn = useSelectorAgentSignIn(tab, workspace, retry)
  return (
    <div className="flex flex-col gap-2 px-1">
      <SignInActions tab={tab} signIn={signIn} retry={retry} disabled={disabled} touch={touch} />
    </div>
  )
}
