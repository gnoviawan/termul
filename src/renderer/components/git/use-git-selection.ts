import type { GitStatusDetail } from '@shared/types/ipc.types'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useGitStatusStore } from '@/stores/git-status-store'

export type GitSelectionSection = 'staged' | 'unstaged'

export function useGitSelection() {
  const setSelectedFile = useGitStatusStore((state) => state.setSelectedFile)

  // Track which side (staged vs unstaged) of the selected path is shown, since
  // an `MM` file appears in both sections under the same path.
  const [selectedStaged, setSelectedStaged] = useState(false)

  // Multi-selection model. Selection is scoped to a single section (staged or
  // unstaged), since the same path can exist in both and they are staged /
  // unstaged independently. `anchorPath` is the pivot for shift-range selects.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [selectionSection, setSelectionSection] = useState<GitSelectionSection | null>(null)
  const [anchorPath, setAnchorPath] = useState<string | null>(null)

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set())
    setSelectionSection(null)
    setAnchorPath(null)
  }, [])

  // Click selection with VSCode-style modifiers:
  // - plain click  → select only this row
  // - ctrl/cmd     → toggle this row in the selection
  // - shift        → select the contiguous range from the anchor
  // Selection is always scoped to the clicked row's section.
  const handleFileClick = useCallback(
    (
      e: React.MouseEvent | React.KeyboardEvent,
      path: string,
      staged: boolean,
      sectionFiles: GitStatusDetail[]
    ) => {
      const section: GitSelectionSection = staged ? 'staged' : 'unstaged'
      const sameSection = selectionSection === section

      if (e.shiftKey && sameSection && anchorPath) {
        const paths = sectionFiles.map((f) => f.path)
        const a = paths.indexOf(anchorPath)
        const b = paths.indexOf(path)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setSelectedPaths(new Set(paths.slice(lo, hi + 1)))
          setSelectionSection(section)
        }
      } else if (e.ctrlKey || e.metaKey) {
        const next = new Set(sameSection ? selectedPaths : [])
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        setSelectedPaths(next)
        setSelectionSection(next.size > 0 ? section : null)
        setAnchorPath(path)
      } else {
        setSelectedPaths(new Set([path]))
        setSelectionSection(section)
        setAnchorPath(path)
      }

      // The diff view always follows the most-recently clicked row.
      setSelectedFile(path)
      setSelectedStaged(staged)
    },
    [selectionSection, selectedPaths, anchorPath, setSelectedFile]
  )

  // Resolve the paths an inline row action should affect: when the row is part
  // of an active multi-selection in its section, act on the whole selection;
  // otherwise act on just that row.
  const targetsFor = useCallback(
    (path: string, section: GitSelectionSection): string[] => {
      if (selectionSection === section && selectedPaths.size > 0 && selectedPaths.has(path)) {
        return [...selectedPaths]
      }
      return [path]
    },
    [selectionSection, selectedPaths]
  )

  return {
    selectedStaged,
    setSelectedStaged,
    selectedPaths,
    selectionSection,
    anchorPath,
    clearSelection,
    handleFileClick,
    targetsFor
  }
}
