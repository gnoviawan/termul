import { BorderBeam } from 'border-beam'

/**
 * BorderBeam only when motion is allowed. Under prefers-reduced-motion the beam
 * wrapper is omitted entirely (no keyframes / data-active), not merely paused.
 */
export function ComposerBeamShell({
  busy,
  reduced,
  children
}: {
  busy: boolean
  reduced: boolean
  children: React.ReactNode
}): React.JSX.Element {
  if (reduced) {
    return <div className="relative z-10 w-full">{children}</div>
  }
  return (
    <BorderBeam
      size="md"
      colorVariant="mono"
      theme="auto"
      borderRadius={16}
      active={busy}
      className="relative z-10 w-full"
    >
      {children}
    </BorderBeam>
  )
}
