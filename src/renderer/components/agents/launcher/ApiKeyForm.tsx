import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AuthMethod } from '@/lib/acp-api'

/**
 * A sign-in method that takes a key the user types. The key goes to
 * `onSubmit` once and the field clears; an empty submit runs the method
 * without one, so the agent reads its own environment.
 */
export function ApiKeyForm({
  method,
  layout,
  size,
  variant,
  disabled = false,
  onSubmit
}: {
  method: AuthMethod
  layout: 'row' | 'stack'
  size: 'sm' | 'touch'
  variant: 'default' | 'secondary' | 'outline'
  disabled?: boolean
  onSubmit: (apiKey: string | undefined) => void
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  return (
    <form
      className={layout === 'row' ? 'flex flex-wrap items-center gap-2' : 'flex flex-col gap-2'}
      onSubmit={(event) => {
        event.preventDefault()
        const typed = apiKey.trim()
        setApiKey('')
        onSubmit(typed || undefined)
      }}
    >
      <Input
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        placeholder="API key"
        aria-label={`Key for ${method.name}`}
        className={layout === 'row' ? 'h-8 w-48' : undefined}
        disabled={disabled}
      />
      <Button
        type="submit"
        size={size}
        variant={variant}
        className={layout === 'stack' ? 'w-full' : undefined}
        title={method.description ?? undefined}
        disabled={disabled}
      >
        {method.name}
      </Button>
    </form>
  )
}
