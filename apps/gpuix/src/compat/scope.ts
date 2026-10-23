/**
 * Descendant rules from index.css (`.chat-streamdown p { … }`): class
 * strings an element gains when it sits under an ancestor with the named
 * class. The ancestor provides `ScopeContext`; the descendant reads it while
 * the component that creates it renders, which is where streamdown creates
 * its `<p>` and lists. `use(context)` is legal there, conditionally; outside a
 * render (module scope, an event handler) there is no scope.
 */

import * as React from 'react'
import { createContext, use } from 'react'

export type ScopeName = 'chat-streamdown'

interface DescendantRule {
  tag?: string
  /** `data-streamdown` value. */
  part?: RegExp
  classes: string
}

/**
 * index.css values at the chat's 14px text size (em resolved to px). The
 * rules sit in `@layer components`, below every utility, so they go in front
 * of the element's own classes. Margins are left out: streamdown's block
 * container sets `space-y-4`, a utility on the parent that wins over them.
 */
export const DESCENDANT_RULES: Readonly<Record<ScopeName, readonly DescendantRule[]>> = {
  'chat-streamdown': [
    { part: /^(ordered|unordered)-list$/, classes: 'pl-5' },
    { part: /^list-item$/, classes: 'py-[1.12px]' },
    { part: /^blockquote$/, classes: 'border-l-2 pl-[10.4px]' },
    { part: /^heading-/, classes: 'font-semibold leading-[1.25]' }
  ]
}

export const SCOPES = new Set<string>(Object.keys(DESCENDANT_RULES))
const CANDIDATE_TAGS = new Set(['ul', 'ol', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4'])

export const ScopeContext = createContext<ScopeName | null>(null)

/** React's current dispatcher: set while a component renders, null otherwise. */
const internals = (React as unknown as Record<string, { H: unknown } | undefined>)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

function currentScope(): ScopeName | null {
  if (!internals?.H) return null
  try {
    return use(ScopeContext)
  } catch {
    return null
  }
}

/** Extra classes for an element created now with this tag and `data-streamdown` part. */
export function scopedClasses(tag: string, part: unknown): string | null {
  if (!CANDIDATE_TAGS.has(tag) && typeof part !== 'string') return null
  const scope = currentScope()
  if (!scope) return null
  let out: string | null = null
  for (const rule of DESCENDANT_RULES[scope]) {
    if (rule.tag !== undefined && rule.tag !== tag) continue
    if (rule.part !== undefined && !(typeof part === 'string' && rule.part.test(part))) continue
    out = out ? `${out} ${rule.classes}` : rule.classes
  }
  return out
}
