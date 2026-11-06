/**
 * Shared copy and timing for the browser consent surfaces: the in-pane
 * `BrowserConsentStrip` and the in-chat `BrowserConsentCard` render the same
 * ticket fields so a request reads identically wherever it surfaces. Only
 * host-supplied fields are shown, never page title or text; the agent's
 * stated intent is labelled as the agent's.
 */

import { useEffect, useState } from 'react'
import {
  type BrowserConsentAction,
  type BrowserConsentOptionId,
  type BrowserConsentTicket,
  CONSENT_ANSWER_FLOOR_MS
} from '@/lib/browser-consent-api'

const TITLES: Record<BrowserConsentAction, string> = {
  navigate: 'Allow the agent to open this site?',
  local_network: 'Allow the agent to open this site?',
  password_submit: 'Allow the agent to submit a password?',
  payment_submit: 'Allow the agent to submit payment details?',
  upload: 'Allow the agent to upload a file?',
  download: 'Allow the agent to keep a download?',
  tainted_exfil: 'Allow the agent to send page data to another site?'
}

export function browserConsentTitle(action: BrowserConsentAction): string {
  return TITLES[action]
}

/**
 * Sensitive actions (everything but opening a site) are allowed one action
 * at a time, and their project option pre-approves that action on the site.
 */
function isSensitiveConsent(action: BrowserConsentAction): boolean {
  return action !== 'navigate' && action !== 'local_network'
}

/** Generic actor when the requesting agent's live id is unmapped. */
export const BROWSER_CONSENT_ACTOR = 'The agent'

const ACTION_PHRASES: Record<BrowserConsentAction, string> = {
  navigate: 'open',
  local_network: 'open a local network address at',
  password_submit: 'submit a password on',
  payment_submit: 'submit payment details on',
  upload: 'upload a file to',
  download: 'download a file from',
  tainted_exfil: 'send page data to'
}

/** e.g. `Claude wants to open https://example.com in the agent browser.` */
export function browserConsentSummary(
  agentName: string | undefined,
  ticket: Pick<BrowserConsentTicket, 'action' | 'origin'>
): string {
  return `${agentName ?? BROWSER_CONSENT_ACTOR} wants to ${ACTION_PHRASES[ticket.action]} ${ticket.origin} in the agent browser.`
}

const PROFILE_LABELS: Record<BrowserConsentTicket['profile'], string> = {
  global: 'Global agent profile, shared across all projects',
  ephemeral: 'Ephemeral profile, discarded when the session ends'
}

export function browserConsentProfileLabel(profile: BrowserConsentTicket['profile']): string {
  return PROFILE_LABELS[profile]
}

/** The target URL line, with the byte count when the host shortened it. */
export function browserConsentTargetLine(
  ticket: Pick<BrowserConsentTicket, 'targetUrl' | 'targetUrlBytes'>
): string {
  const shortened = ticket.targetUrlBytes > ticket.targetUrl.length
  return shortened ? `${ticket.targetUrl} (${ticket.targetUrlBytes} bytes)` : ticket.targetUrl
}

/** e.g. `report.pdf (9 bytes)`. */
export function browserConsentFileLine(file: NonNullable<BrowserConsentTicket['file']>): string {
  return `${file.name} (${file.bytes} bytes)`
}

const ORIGIN_OPTION_LABELS: Record<BrowserConsentOptionId, string> = {
  allow_session: 'Allow for this session',
  allow_project: 'Always allow for this project',
  deny: 'Deny'
}

const SENSITIVE_OPTION_LABELS: Record<BrowserConsentOptionId, string> = {
  allow_session: 'Allow once',
  allow_project: 'Always allow on this site for this project',
  deny: 'Deny'
}

export function browserConsentOptionLabel(
  optionId: BrowserConsentOptionId,
  action: BrowserConsentAction
): string {
  return (isSensitiveConsent(action) ? SENSITIVE_OPTION_LABELS : ORIGIN_OPTION_LABELS)[optionId]
}

/**
 * Sanitized DOM id for the card's `aria-labelledby` target. The requestId is
 * host-generated, but strip non-alphanumeric characters defensively so the
 * id is always a valid HTML/CSS identifier.
 */
export function browserConsentTitleId(requestId: string): string {
  const safe = requestId.replace(/[^a-zA-Z0-9-]/g, '')
  return `browser-consent-title-${safe}`
}

/** A little past the host's floor, so a deliberate first click never bounces. */
export const CONSENT_ARM_DELAY_MS = CONSENT_ANSWER_FLOOR_MS + 50

/**
 * Whether the answer buttons for `requestId` accept clicks yet. They arm a
 * moment after the prompt appears, so a click aimed at something that just
 * moved under the pointer cannot approve it.
 */
export function useConsentArmed(requestId: string): boolean {
  const [armedFor, setArmedFor] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setArmedFor(requestId), CONSENT_ARM_DELAY_MS)
    return () => clearTimeout(timer)
  }, [requestId])
  return armedFor === requestId
}
