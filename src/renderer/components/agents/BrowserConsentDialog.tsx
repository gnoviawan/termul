/**
 * Agent browser-automation consent prompt (spec-acp-browser-pane-automation).
 *
 * Shown when the host's `browser` tool gate emits
 * `acp:browser_consent_request` — the agent's first browser action of a
 * session. Granting applies once per session (the host caches the grant);
 * denying fails the pending call and re-prompts on the agent's next call.
 * Agent tabs open in the visible browser pane with an Agent badge; closing
 * the tab revokes control.
 */

import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useAgentDisplayName } from '@/hooks/use-agent-display-name'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useIsConsentStripHosting } from '@/stores/browser-consent-strip-store'

export function BrowserConsentDialogHost(): React.JSX.Element | null {
  const pending = useAcpStore((s) => s.pendingBrowserConsents)
  const respond = useAcpStore((s) => s.respondBrowserConsent)
  const stripHosting = useIsConsentStripHosting()
  const first = Object.values(pending ?? {})[0]
  const agentName = useAgentDisplayName(first?.agentId)
  // Consent is granted on the desktop host only in phase 1 — remote clients
  // (WS relay) never see a dead prompt; the host auto-denies on timeout.
  if (!isTauriContext()) return null
  if (!first) return null
  // The in-pane consent strip owns the prompt while a live strip is mounted
  // for the focused pane's active browser tab — the native webview would
  // paint over this centered modal anyway (spec-acp-browser-pane-agent-ui).
  if (stripHosting) return null

  const intent = first.element
    ? ` — it wants to ${first.action} "${first.element}"`
    : ` — first action: ${first.action}`
  return (
    <ConfirmDialog
      isOpen
      title="Allow browser automation?"
      message={`${agentName ?? 'The agent'} wants to drive this app's browser for this session${intent}. You'll watch it work in a visible tab; closing the tab stops it.`}
      confirmLabel="Allow for this session"
      cancelLabel="Deny"
      variant="danger"
      onConfirm={() => respond(first.requestId, true)}
      onCancel={() => respond(first.requestId, false)}
    />
  )
}
