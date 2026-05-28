/**
 * Worktree keyboard shortcut handlers.
 *
 * Registers worktree shortcuts from the keyboard-shortcuts store
 * and connects them to project actions. This hook should be used
 * at the workspace level where project context is available.
 *
 * Supported shortcuts:
 * - worktreeCreate: Open NewWorktreeModal
 * - worktreeSwitchNext: Cycle to next worktree
 * - worktreeSwitchPrev: Cycle to previous worktree
 * - worktreeSwitchRoot: Switch to project root
 * - worktreeMergeToMain: Open merge preview
 * - worktreeArchive: Archive active worktree
 * - worktreeOpenTerminal: Open terminal in worktree CWD
 * - worktreeSyncMain: Sync main into worktree (future)
 */

import { useEffect } from 'react'
import { useKeyboardShortcutsStore, matchesShortcut } from '@/stores/keyboard-shortcuts-store'
import { useProjectStore, useProjectActions } from '@/stores/project-store'
import { getActiveWorktreeForProject } from '@/lib/worktree-context'

// Event name constants for cross-component communication
export const WORKTREE_EVENTS = {
	OPEN_CREATE_MODAL: 'worktree:open-create-modal',
	OPEN_MERGE_DIALOG: 'worktree:open-merge-dialog',
	OPEN_ARCHIVE_DIALOG: 'worktree:open-archive-dialog',
	OPEN_TERMINAL: 'worktree:open-terminal',
} as const

/**
 * Dispatch a custom event to trigger worktree UI actions from shortcuts.
 * This decouples the shortcut handler from specific component state.
 */
export function dispatchWorktreeEvent(event: string, detail?: unknown): void {
	window.dispatchEvent(new CustomEvent(event, { detail }))
}

/**
 * Get the active key for a shortcut ID from the store.
 */
function useGetActiveKey(): (id: string) => string {
	const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
	return (id: string) => {
		const shortcut = shortcuts[id]
		return shortcut?.customKey ?? shortcut?.defaultKey ?? ''
	}
}

export function useWorktreeShortcuts(): void {
	const getActiveKey = useGetActiveKey()
	const projects = useProjectStore((state) => state.projects)
	const activeProjectId = useProjectStore((state) => state.activeProjectId)
	const { setActiveWorktree } = useProjectActions()

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent): void => {
			if (e.defaultPrevented) return
			if (!activeProjectId) return

			const project = projects.find((p) => p.id === activeProjectId)
			if (!project) return

			// Worktree Create — open modal via custom event
			if (matchesShortcut(e, getActiveKey('worktreeCreate'))) {
				e.preventDefault()
				e.stopPropagation()
				dispatchWorktreeEvent(WORKTREE_EVENTS.OPEN_CREATE_MODAL, { projectId: activeProjectId })
				return
			}

			// Switch to next worktree
			if (matchesShortcut(e, getActiveKey('worktreeSwitchNext'))) {
				e.preventDefault()
				const wts = project.worktrees ?? []
				if (wts.length === 0) return
				const currentIdx = project.activeWorktreeId
					? wts.findIndex((w) => w.id === project.activeWorktreeId)
					: -1
				const nextIdx = (currentIdx + 1) % wts.length
				setActiveWorktree(project.id, wts[nextIdx].id)
				return
			}

			// Switch to previous worktree
			if (matchesShortcut(e, getActiveKey('worktreeSwitchPrev'))) {
				e.preventDefault()
				const wts = project.worktrees ?? []
				if (wts.length === 0) return
				const idx = project.activeWorktreeId
					? wts.findIndex((w) => w.id === project.activeWorktreeId)
					: wts.length
				// Normalize -1 (orphaned ID) to wts.length so prev wraps to last element
				const currentIdx = idx === -1 ? wts.length : idx
				const prevIdx = (currentIdx - 1 + wts.length) % wts.length
				setActiveWorktree(project.id, wts[prevIdx].id)
				return
			}

			// Switch to project root
			if (matchesShortcut(e, getActiveKey('worktreeSwitchRoot'))) {
				e.preventDefault()
				setActiveWorktree(project.id, null)
				return
			}

			// Merge to main — open merge dialog via custom event
			if (matchesShortcut(e, getActiveKey('worktreeMergeToMain'))) {
				e.preventDefault()
				e.stopPropagation()
				const activeWt = getActiveWorktreeForProject(activeProjectId)
				if (activeWt) {
					dispatchWorktreeEvent(WORKTREE_EVENTS.OPEN_MERGE_DIALOG, {
						worktreePath: activeWt.path,
						projectPath: project.path,
						sourceBranch: activeWt.branch,
						projectName: project.name,
						targetBranch: 'main',
					})
				}
				return
			}

			// Archive active worktree — open archive/removal dialog via custom event
			if (matchesShortcut(e, getActiveKey('worktreeArchive'))) {
				e.preventDefault()
				e.stopPropagation()
				const activeWt = getActiveWorktreeForProject(activeProjectId)
				if (activeWt) {
					dispatchWorktreeEvent(WORKTREE_EVENTS.OPEN_ARCHIVE_DIALOG, {
						worktree: activeWt,
						projectId: activeProjectId,
					})
				}
				return
			}

			// Open terminal in worktree CWD
			if (matchesShortcut(e, getActiveKey('worktreeOpenTerminal'))) {
				e.preventDefault()
				dispatchWorktreeEvent(WORKTREE_EVENTS.OPEN_TERMINAL, { projectId: activeProjectId })
				return
			}

			// Sync main into worktree (future)
			if (matchesShortcut(e, getActiveKey('worktreeSyncMain'))) {
				e.preventDefault()
				const activeWt = getActiveWorktreeForProject(activeProjectId)
				if (activeWt) {
					dispatchWorktreeEvent(WORKTREE_EVENTS.OPEN_MERGE_DIALOG, {
						worktreePath: activeWt.path,
						projectPath: project.path,
						sourceBranch: 'main',
						projectName: project.name,
						targetBranch: activeWt.branch,
					})
				}
				return
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [activeProjectId, projects, getActiveKey, setActiveWorktree])
}