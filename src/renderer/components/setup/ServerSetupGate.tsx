/**
 * Setup-mode gate for the web client (gh-1105).
 *
 * Mounted around the web app root (`App.tsx`) — never on `TauriApp.tsx`, the
 * desktop app has no `termul-server` setup mode. While `useWebSetupGate`
 * reports `setup` (the server's public `/health` advertises `setupRequired`,
 * i.e. no completed `server-config.json`), the app is swapped for the
 * full-screen {@link ServerSetupWizard}: children — and every `AppEffects`
 * hook that assumes a configured server — must never run in setup mode.
 *
 * While the gate is `checking` a loading splash stands in for children for
 * the same reason: rendering the app before the probe resolves would boot
 * the app stack against a setup-mode server for one round-trip.
 *
 * `useWebSetupGate` owns the `/health` probe (starts it on first
 * subscriber); the setup token for `/setup/*` calls is read from the
 * `?setup=` URL param by `webSetupApi` — neither is this component's
 * concern.
 */

import { useWebSetupGate } from '@/lib/web-setup-gate'
import { ServerSetupWizard } from './ServerSetupWizard'

export function ServerSetupGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const gate = useWebSetupGate()

  if (gate === 'setup') {
    return <ServerSetupWizard mode="setup" />
  }
  if (gate === 'checking') {
    return (
      <div className="flex h-screen flex-col items-center justify-center overflow-hidden bg-background">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }
  return <>{children}</>
}
