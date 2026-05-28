import { useState, useCallback, useEffect } from 'react'
import { AlertTriangle, Archive, Trash2, Loader2, GitBranch } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Worktree } from '@/types/project'
import { isWorktreeTermulManaged } from '@/types/project'
import { worktreeApi } from '@/lib/api'
import { useProjectStore, useProjectActions } from '@/stores/project-store'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import type { DirtyStatus } from '@shared/types/ipc.types'

type RemovalMode = 'archive' | 'delete'

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
	const [mode, setMode] = useState<RemovalMode>('archive')
	const [deleteLocalBranch, setDeleteLocalBranch] = useState(false)
	const [dirtyStatus, setDirtyStatus] = useState<DirtyStatus | null>(null)
	const [dirtyLoading, setDirtyLoading] = useState(false)
	const [isRemoving, setIsRemoving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const isTermulManaged = worktree ? isWorktreeTermulManaged(worktree) : false
	const isMainBranch = worktree ? ['main', 'master'].includes(worktree.branch) : false
	const hasUncommittedChanges = dirtyStatus?.hasChanges ?? false

	// Fetch dirty status when dialog opens
	useEffect(() => {
		if (!isOpen || !worktree?.path) return
		setDirtyLoading(true)
		setDirtyStatus(null)

		const checkDirty = async () => {
			try {
				const result = await worktreeApi.checkDirty(worktree.path)
				if (result.success && result.data) {
					setDirtyStatus(result.data)
				}
			} catch {
				// Dirty check is best-effort
			} finally {
				setDirtyLoading(false)
			}
		}
		void checkDirty()
	}, [isOpen, worktree?.path])

	// Reset state when dialog opens
	useEffect(() => {
		if (isOpen) {
			setMode('archive')
			setDeleteLocalBranch(false)
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
		if (!worktree || !isTermulManaged) return

		setIsRemoving(true)
		setError(null)
		setWorktreeOperationLock(true)

		try {
			// For archive, we just remove the worktree normally.
			// The actual archiving (moving to .termul/archives/) would be a Rust-side operation.
			// For now, we use the standard remove which cleans up properly.
			const result = await worktreeApi.remove(worktree.path, false)
			if (result.success) {
				removeWorktree(projectId, worktree.id)
				toast({
					title: 'Worktree archived',
					description: `"${worktree.name}" has been archived and can be recovered within 30 days.`,
				})
				onClose()
			} else {
				setError(result.error ?? 'Failed to archive worktree')
				toast({
					title: 'Failed to archive worktree',
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
	}, [worktree, isTermulManaged, projectId, removeWorktree, setWorktreeOperationLock, onClose])

	const handleDelete = useCallback(async () => {
		if (!worktree) return

		setIsRemoving(true)
		setError(null)
		setWorktreeOperationLock(true)

		try {
			// Force remove for permanent deletion
			const result = await worktreeApi.remove(worktree.path, true)
			if (result.success) {
				removeWorktree(projectId, worktree.id)
				toast({
					title: 'Worktree deleted',
					description: `"${worktree.name}" has been permanently deleted.`,
				})
				onClose()
			} else {
				setError(result.error ?? 'Failed to delete worktree')
				toast({
					title: 'Failed to delete worktree',
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
	}, [worktree, projectId, removeWorktree, setWorktreeOperationLock, onClose])

	const handleConfirm = useCallback(() => {
		if (mode === 'archive') {
			void handleArchive()
		} else {
			void handleDelete()
		}
	}, [mode, handleArchive, handleDelete])

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

							{/* Removal mode selection */}
							<div className="space-y-2">
								<label className="block text-xs font-medium text-muted-foreground">
									Removal Method
								</label>
								<div className="space-y-2">
									{/* Archive option */}
									<button
										onClick={() => setMode('archive')}
										className={cn(
											'w-full flex items-start gap-3 p-3 rounded border text-left transition-colors',
											mode === 'archive'
												? 'border-primary bg-primary/5'
												: 'border-border hover:bg-sidebar-accent/50',
										)}
									>
										<Archive size={16} className={cn('mt-0.5 flex-shrink-0', mode === 'archive' ? 'text-primary' : 'text-muted-foreground')} />
										<div>
											<div className="text-xs font-medium text-foreground">Archive (Recommended)</div>
											<div className="text-[10px] text-muted-foreground mt-0.5">
												Moves to .termul/archives/. Recoverable for 30 days.
											</div>
										</div>
									</button>
									{/* Delete option */}
									<button
										onClick={() => setMode('delete')}
										className={cn(
											'w-full flex items-start gap-3 p-3 rounded border text-left transition-colors',
											mode === 'delete'
												? 'border-red-500 bg-red-500/5'
												: 'border-border hover:bg-sidebar-accent/50',
										)}
									>
										<Trash2 size={16} className={cn('mt-0.5 flex-shrink-0', mode === 'delete' ? 'text-red-500' : 'text-muted-foreground')} />
										<div>
											<div className="text-xs font-medium text-foreground">Delete Permanently</div>
											<div className="text-[10px] text-muted-foreground mt-0.5">
												Permanently deletes the worktree directory. Cannot be undone.
											</div>
										</div>
									</button>
								</div>
							</div>

							{/* Delete local branch checkbox */}
							{mode === 'delete' && (
								<label className="flex items-center gap-2 text-xs cursor-pointer">
									<input
										type="checkbox"
										checked={deleteLocalBranch}
										onChange={(e) => setDeleteLocalBranch(e.target.checked)}
										className="rounded border-border"
									/>
									<span className="text-muted-foreground">Also delete local branch "{worktree.branch}"</span>
								</label>
							)}

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
								onClick={handleConfirm}
								disabled={isRemoving || isWorktreeOperationLocked || !isTermulManaged}
								className={cn(
									'px-3 py-1.5 text-xs font-medium rounded transition-all flex items-center gap-1.5',
									mode === 'delete'
										? 'bg-red-500 text-white hover:bg-red-600 shadow-md'
										: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-md shadow-primary/20',
									'disabled:opacity-50 disabled:cursor-not-allowed',
								)}
							>
								{isRemoving && <Loader2 size={12} className="animate-spin" />}
								{isRemoving
									? mode === 'archive' ? 'Archiving...' : 'Deleting...'
									: mode === 'archive' ? 'Archive Worktree' : 'Delete Worktree'}
							</button>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	)
}