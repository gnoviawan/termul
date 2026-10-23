/**
 * GPUIX `GlobalContextMenu`. The web menu (Copy / Cut / Paste / Select All)
 * reads and restores DOM text selections, which GPUIX does not expose to the
 * tree, so every item would be disabled; the window keeps no app-wide menu
 * and GPUIX inputs keep their own editing keys. The web wrapper is a
 * `display: contents` div, which Taffy has no equivalent for, so the wrapper
 * here fills the window instead.
 */

import type { ReactNode } from 'react'
import { Box } from '../../ui/internal/host'

export function GlobalContextMenu({ children }: { children: ReactNode }) {
  return <Box className="flex h-full w-full flex-col">{children}</Box>
}
