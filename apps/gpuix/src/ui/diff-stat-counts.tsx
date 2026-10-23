import { tw } from '../style/tw'

interface DiffStatCountsProps {
  added: number
  removed: number
  omitZero?: boolean
}

/** `+N` in success ink, `−M` in destructive ink, one space apart, as runs of the caller's line. */
export function DiffStatCounts({ added, removed, omitZero = false }: DiffStatCountsProps) {
  const showAdded = !omitZero || added > 0
  const showRemoved = !omitZero || removed > 0
  if (!showAdded && !showRemoved) return null
  return (
    <>
      {showAdded && <text style={tw('text-success')}>+{added}</text>}
      {showAdded && showRemoved && <text> </text>}
      {showRemoved && <text style={tw('text-destructive')}>−{removed}</text>}
    </>
  )
}
