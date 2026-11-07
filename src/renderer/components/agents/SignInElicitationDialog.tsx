/**
 * Agent sign-in by link and code (Codex "ChatGPT (device code)"): the agent
 * asked the user to visit a URL and follow its message, which carries the
 * code to enter there. The user can do that on any device, so this works on
 * a headless server and from a phone. Open answers the agent with accept and
 * keeps the dialog up, because the user still needs the code; the host
 * closes it when the sign-in finishes. Dismissing before Open cancels the
 * sign-in.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { AgentId } from '@/lib/acp-api'
import { openerApi } from '@/lib/api'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Split a trailing code off the agent's message (`"… enter this code:
 * ABCD-1234"`) so it can be shown large and copied on its own. `null` when
 * the message ends in no code-shaped token; the dialog then shows it whole.
 */
export function splitSignInCode(message: string): { text: string; code: string } | null {
  const match = /^(.*\S)\s*:\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)\s*$/s.exec(message)
  if (!match) return null
  const [, text, code] = match
  if (code.replace(/-/g, '').length < 4 || !/\d/.test(code)) return null
  return { text, code }
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}.`)
  }
}

export function SignInElicitationDialog({
  agentId,
  agentName,
  url,
  message
}: {
  agentId: AgentId
  agentName: string
  url: string
  message: string
}): React.JSX.Element {
  const respondAgentSignIn = useAcpStore((s) => s.respondAgentSignIn)
  const clearPendingSignIn = useAcpStore((s) => s.clearPendingSignIn)
  const [accepted, setAccepted] = useState(false)
  const split = splitSignInCode(message)

  const respond = (action: 'accept' | 'cancel'): void => {
    void respondAgentSignIn(agentId, action).catch(() => {
      toast.error(
        action === 'accept'
          ? `${agentName} did not get the sign-in confirmation. Try signing in again.`
          : `Could not cancel the ${agentName} sign-in.`
      )
    })
  }

  const handleOpen = (): void => {
    // Web: the facade calls `window.open` inside this click, so a popup
    // blocker lets it through. Never log the URL.
    void openerApi.openUrlWithSystemBrowser(url).then((result) => {
      if (!result.success) toast.error(result.error ?? 'Could not open the sign-in page.')
    })
    if (accepted) return
    setAccepted(true)
    respond('accept')
  }

  // Before Open the agent is still waiting for an answer, so dismissing
  // cancels the sign-in. After it the agent waits for the login itself and
  // cannot be called off from here; dismissing only hides the dialog.
  const handleDismiss = (): void => {
    if (accepted) clearPendingSignIn(agentId)
    else respond('cancel')
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleDismiss()
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-sm">{`Sign in to ${agentName}`}</DialogTitle>
          <DialogDescription>
            {accepted
              ? 'Finish signing in on the page that opened. This closes on its own when sign-in is done.'
              : 'Open the sign-in page on this or any other device and enter the code below.'}
          </DialogDescription>
        </DialogHeader>

        {split ? (
          <div className="space-y-2">
            <p className="text-sm text-foreground">{split.text}</p>
            <div className="flex items-center gap-2">
              <output
                aria-label="Sign-in code"
                className="min-w-0 flex-1 select-all rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-center font-mono text-lg font-semibold tracking-widest text-foreground"
              >
                {split.code}
              </output>
              <Button
                type="button"
                variant="outline"
                onClick={() => void copyText(split.code, 'Code')}
              >
                Copy code
              </Button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm text-foreground">{message}</p>
        )}

        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
            {url}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copyText(url, 'Link')}
          >
            Copy link
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleDismiss}>
            {accepted ? 'Hide' : 'Cancel sign-in'}
          </Button>
          <Button type="button" onClick={handleOpen}>
            Open sign-in page
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
