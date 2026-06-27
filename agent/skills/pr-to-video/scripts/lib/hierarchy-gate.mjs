// Scene visual-hierarchy gate for validate-section.mjs.
//
// A scene is "risky" when it stacks competing focal claims — a multi-act scene,
// or an action/payoff (CTA) co-existing with proof (logos / stats). Risky scenes
// must declare a **PrimarySubjectTimeline:** and a **Handoff:** so one subject
// owns the frame at a time. This module decides risk; the enforcement (which
// anchors a risky scene must carry) stays in validate-section.mjs.
//
// Two sources, in priority order:
//   1. AUTHORITATIVE — a structured `**Hierarchy:**` anchor the planner declares.
//      This is a pure schema read (no prose scanning), so it never costs review
//      to reason about regex alternations. Prefer it.
//   2. FALLBACK — the prose classifier below, kept for plans that don't declare
//      the anchor yet. Once an E2E replay confirms the planner reliably emits
//      `**Hierarchy:**`, this fallback (classifyHierarchy + its regexes) can be
//      deleted and the gate becomes a pure schema check.

// Fixed vocabulary for the **Hierarchy:** anchor. `simple` is the explicit
// "no competing focal claims" declaration (risky=false). The others map 1:1 to
// the prose classifier's signals so both sources produce the same shape.
export const HIERARCHY_TAGS = ['simple', 'multi-act', 'action', 'social-proof', 'data-proof']

// Read the authoritative `**Hierarchy:** <tags>` anchor. Returns null when the
// anchor is absent (→ caller falls back to the prose classifier). When present,
// returns the risk shape plus any `unknown` tags (caller turns those into a
// validation error so a typo can't silently disable the gate).
export function declaredHierarchy(body) {
  const m = body.match(/^\*\*Hierarchy:\*\*\s*(.*)$/m)
  if (!m) return null
  const tags = m[1]
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean)
  const allowed = new Set(HIERARCHY_TAGS)
  const unknown = tags.filter((t) => !allowed.has(t))
  const multiAct = tags.includes('multi-act')
  const hasAction = tags.includes('action')
  const hasSocialProof = tags.includes('social-proof')
  const hasDataProof = tags.includes('data-proof')
  return {
    source: 'declared',
    unknown,
    multiAct,
    hasAction,
    hasSocialProof,
    hasDataProof,
    risky: multiAct || (hasAction && (hasSocialProof || hasDataProof))
  }
}

const hasAny = (text, patterns) => patterns.some((pattern) => pattern.test(text))

// Strip negated clauses so a scene that only mentions proof to DENY it (e.g. a
// pure CTA: "there is no logo strip / customer logo / stat counter / chart")
// doesn't read as a proof scene. Each negation eats to the next sentence stop.
// This is what lets a CTA stop writing anti-regex defensive prose.
function stripNegations(text) {
  return text.replace(
    /\b(no|not|never|without|isn'?t|aren'?t|don'?t|doesn'?t|won'?t|cannot|can'?t)\b[^.;:]*/gi,
    ' '
  )
}

// FALLBACK prose classifier — the historical hierarchyRisk(). Same return shape
// as declaredHierarchy() so callers don't branch on the source.
export function classifyHierarchy(body) {
  const text = body.toLowerCase()
  // Proof signals are read from (1) cited component ids — an unambiguous,
  // structured signal preferred over fuzzy prose scans — and (2) the prose with
  // negated clauses removed, using PHRASE patterns (not bare "logo"/"customer",
  // which over-trigger on brand wordmarks and incidental mentions).
  const proofText = stripNegations(text)
  const compM = body.match(/^\*\*Components:\*\*\s*(.*)$/m)
  const compIds = compM ? [...compM[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : []
  const compProof = compIds.some((id) => /logo|proof|testimonial|customer/i.test(id))
  const compData = compIds.some((id) => /stat|chart|metric|kpi|counter/i.test(id))

  const multiAct = /\b(multi[- ]?act|three[- ]?act|act\s+[abc]|\bfocal points?)\b/i.test(text)
  const hasAction =
    /\b(cta|get started|call[- ]?to[- ]?action|button|sign up|book demo|start trial|download|subscribe|contact sales|action headline|payoff frame|payoff close|closing action)\b/i.test(
      text
    )
  const hasSocialProof =
    compProof ||
    hasAny(proofText, [
      /logo[- ]?(strip|grid|wall|cloud|chain|row|rail|lockup)/i,
      /\btrusted by\b/i,
      /social[- ]proof/i,
      /\btestimonials?\b/i,
      /customer logos?/i,
      /enterprise logos?/i,
      /\bbrands? you (know|trust)\b/i
    ])
  const hasDataProof =
    compData ||
    hasAny(proofText, [
      /\bstats?\b/i,
      /\bstat[- ]?counter\b/i,
      /\bmetrics?\b/i,
      /\bkpis?\b/i,
      /\bproof cluster\b/i,
      /\bproof rail\b/i,
      /\bchart\b/i,
      /\bcount[- ]?up\b/i,
      /\bpolicy compliance\b/i,
      /\bhours saved\b/i,
      /\byield\b/i
    ])
  return {
    source: 'prose',
    unknown: [],
    multiAct,
    hasAction,
    hasSocialProof,
    hasDataProof,
    risky: multiAct || (hasAction && (hasSocialProof || hasDataProof))
  }
}

// Resolve a scene's hierarchy profile: prefer the declared anchor (schema check),
// else classify the prose (fallback).
export function hierarchyProfile(body) {
  return declaredHierarchy(body) || classifyHierarchy(body)
}
