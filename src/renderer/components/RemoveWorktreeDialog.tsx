import { useState, useCallback, useEffect } from 'react'
import { AlertTriangle, Trash2, Loader2, GitBranch, Archive } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Worktree } from '@/types/project'
import { isWorktreeTermulManaged } from '@/types/project'
import { worktreeApi } from '@/lib/api'
import { useProjectStore, useProjectActions } from '@/stores/project-store'
import { toast } from '@/hooks/use-toast'
import type { DirtyStatus } from '@shared/types/ipc.types'

interface RemoveWorktreeDialogProps {
	isOpen: boolean
	onClose: () => void
	projectId: string
	worktree: Worktree | null
	projectPath: string
	gitBranch?: string
}

export function RemoveWorktreeDialog({
	isOpen,
	onClose,
	projectId,
	worktree,
	projectPath,
	gitBranch,
}: RemoveWorktreeDialogProps) {
	const isWorktreeOperationLocked = useProjectStore((state) => state.isWorktreeOperationLocked)
	const { removeWorktree, setWorktreeOperationLock } = useProjectActions()

	// State
	const [dirtyStatus, setDirtyStatus] = useState<DirtyStatus | null>(null)
	const [dirtyLoading, setDirtyLoading] = useState(false)
	const [isRemoving, setIsRemoving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [actionMode, setActionMode] = useState<'archive' | 'delete'>('archive')

	const isTermulManaged = worktree ? isWorktreeTermulManaged(worktree) : false
	const isMainBranch = worktree ? ['main', 'master'].includes(worktree.branch) : false
	const hasUncommittedChanges = dirtyStatus?.hasChanges ?? false
	// Note: unpushed-commits check requires 'ahead' field in DirtyStatus (future)

	// Fetch dirty status when dialog opens
	useEffect(() => {
		if (!isOpen || !worktree?.path) return

		let cancelled = false
		const currentPath = worktree.path

		setDirtyLoading(true)
		setDirtyStatus(null)

		const checkDirty = async () => {
			try {
				const result = await worktreeApi.checkDirty(currentPath)
				// Only update state if the effect hasn't been cancelled or re-triggered
				if (!cancelled && worktree?.path === currentPath) {
					if (result.success && result.data) {
						setDirtyStatus(result.data)
					}
				}
			} catch {
				// Dirty check is best-effort
			} finally {
				if (!cancelled) {
					setDirtyLoading(false)
				}
			}
		}
		void checkDirty()

		return () => {
			cancelled = true
		}
	}, [isOpen, worktree?.path])

	// Reset state when dialog opens
	useEffect(() => {
		if (isOpen) {
			setError(null)
			setIsRemoving(false)
		}
	}, [isOpen])

	// Handle Escape key
	useEffect(() => {
		if (!isOpen) return
		const handleEscape = (e: globalThis.KeyboardEvent): void => {
			if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
			}
		}
		window.addEventListener('keydown', handleEscape)
		return () => window.removeEventListener('keydown', handleEscape)
	}, [isOpen, onClose])

	const handleArchive = useCallback(async () => {
		if (!worktree) return
		setIsRemoving(true)
		setError(null)
		setWorktreeOperationLock(true)
		try {
			const result = await worktreeApi.archive(projectPath, worktree.path)
			if (result.success) {
				removeWorktree(projectId, worktree.id)
				toast({
					title: 'Worktree archived',
					description: `"${worktree.name}" has been archived and can be recovered.`,
				})
				onClose()
			} else {
				setError(result.error || 'Failed to archive worktree')
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'An unexpected error occurred')
		} finally {
			setIsRemoving(false)
			setWorktreeOperationLock(false)
		}
	}, [worktree, projectPath, projectId, removeWorktree, setWorktreeOperationLock, onClose])

	const handleRemove = useCallback(async () => {
		if (!worktree) return

		setIsRemoving(true)
		setError(null)
		setWorktreeOperationLock(true)

		try {
			// Use --force when there are uncommitted changes so git doesn't block removal
			const force = hasUncommittedChanges
			const result = await worktreeApi.remove(projectPath, worktree.path, force)
			if (result.success) {
				removeWorktree(projectId, worktree.id)
				toast({
					title: 'Worktree removed',
					description: `"${worktree.name}" has been permanently removed.`,
				})
				onClose()
			} else {
				setError(result.error ?? 'Failed to remove worktree')
				toast({
					title: 'Failed to remove worktree',
					description: result.error ?? 'Unknown error',
					variant: 'destructive',
				})
			}
		} catch (err) {
			setError(String(err))
		} finally {
			setIsRemoving(false)
			setWorktreeOperationLock(false)
		}
	}, [worktree, projectId, projectPath, removeWorktree, setWorktreeOperationLock, onClose, hasUncommittedChanges])

	if (!worktree) return null

	return (
		<AnimatePresence>
			{isOpen && (
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
					onClick={onClose}
				>
					<motion.div
						initial={{ opacity: 0, scale: 0.95, y: 10 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.95, y: 10 }}
						transition={{ duration: 0.15 }}
						className="bg-card rounded-lg shadow-2xl w-[440px] border border-border overflow-hidden"
						onClick={(e) => e.stopPropagation()}
					>
						{/* Header */}
						<div className="px-4 py-3 border-b border-border bg-secondary/50">
							<h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
								<AlertTriangle size={14} className="text-amber-500" />
								Remove Worktree
							</h3>
						</div>

						{/* Content */}
						<div className="p-4 space-y-4">
							{/* Worktree info */}
							<div className="bg-secondary/30 rounded p-3 space-y-1.5 text-xs">
								<div className="flex items-center gap-2">
									<GitBranch size={12} className="text-primary" />
									<span className="font-medium text-foreground">{worktree.name}</span>
									<span className="text-muted-foreground">({worktree.branch})</span>
								</div>
								<div className="text-muted-foreground">{worktree.path}</div>
								{worktree.createdAt && (
									<div className="text-muted-foreground">
										Created: {new Date(worktree.createdAt).toLocaleDateString()}
									</div>
								)}
							</div>

							{/* Dirty status warning */}
							{dirtyLoading && (
								<div className="flex items-center gap-2 text-xs text-muted-foreground">
									<Loader2 size={12} className="animate-spin" />
									Checking for uncommitted changes...
								</div>
							)}
							{hasUncommittedChanges && !dirtyLoading && (
								<div className="flex items-start gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
									<AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
									<div>
										Uncommitted changes detected:
										<span className="ml-1">
											{dirtyStatus?.modified ?? 0} modified, {dirtyStatus?.staged ?? 0} staged, {dirtyStatus?.untracked ?? 0} untracked
										</span>
										<div className="mt-1 text-muted-foreground">
											These changes will be lost when the worktree is removed.
										</div>
									</div>
								</div>
							)}

							{/* Main/master branch warning */}
							{isMainBranch && (
								<div className="flex items-start gap-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
									<AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
									This worktree is on the <strong>{worktree.branch}</strong> branch. Are you sure you want to remove it?
								</div>
							)}

							{/* Non-Termul-managed warning */}
							{!isTermulManaged && (
								<div className="flex items-start gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
									<AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
									This worktree was not created by Termul. Removing it may affect other tools.
								</div>
							)}

							{/* Permanent deletion notice */}
							<div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/30 border border-border rounded px-3 py-2">
								<Trash2 size={12} className="flex-shrink-0 mt-0.5" />
								This will permanently remove the worktree directory. This action cannot be undone.
							</div>

							{/* Error */}
							{error && (
								<div className="flex items-start gap-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
									<AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
									{error}
								</div>
							)}
						</div>

						{/* Footer */}
						<div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
							<button
								onClick={onClose}
								disabled={isRemoving}
								className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								onClick={() => void handleRemove()}
								disabled={isRemoving || isWorktreeOperationLocked}
								className="px-3 py-1.5 text-xs font-medium rounded bg-red-500 text-white hover:bg-red-600 shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
							>
								{isRemoving && <Loader2 size={12} className="animate-spin" />}
								{isRemoving ? 'Removing...' : 'Remove Worktree'}
							</button>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	)
}