import { useState, useCallback, useEffect, KeyboardEvent } from 'react'
import { X, GitBranch, Search, AlertTriangle, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { BranchInfo } from '@shared/types/ipc.types'
import type { Worktree } from '@/types/project'
import { worktreeApi } from '@/lib/api'
import { useProjectStore, useProjectActions } from '@/stores/project-store'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

// Security-sensitive .gitignore patterns that default to NO COPY
const SENSITIVE_GITIGNORE_PATTERNS = [
	{ pattern: '.env*', label: '.env files', copy: false },
	{ pattern: '*.key', label: 'Key files', copy: false },
	{ pattern: '*.pem', label: 'PEM certificates', copy: false },
	{ pattern: '*.p12', label: 'PKCS12 keystores', copy: false },
]

// Common .gitignore patterns that default to COPY
const COMMON_GITIGNORE_PATTERNS = [
	{ pattern: 'node_modules/', label: 'node_modules', copy: true },
	{ pattern: 'dist/', label: 'Build output', copy: true },
	{ pattern: '.cache/', label: 'Cache directories', copy: true },
]

interface GitignoreEntry {
	pattern: string
	label: string
	copy: boolean // true = copy to worktree, false = don't copy
}

interface NewWorktreeModalProps {
	isOpen: boolean
	onClose: () => void
	projectId: string
}

export function NewWorktreeModal({ isOpen, onClose, projectId }: NewWorktreeModalProps) {
	const project = useProjectStore((state) => state.projects.find((p) => p.id === projectId))
	const isWorktreeOperationLocked = useProjectStore((state) => state.isWorktreeOperationLocked)
	const { addWorktree, setWorktreeOperationLock } = useProjectActions()

	// Form state
	const [branchType, setBranchType] = useState<'existing' | 'new'>('new')
	const [selectedBranch, setSelectedBranch] = useState('')
	const [newBranchName, setNewBranchName] = useState('')
	const [startRef, setStartRef] = useState('')
	const [worktreeName, setWorktreeName] = useState('')

	// Branches state
	const [branches, setBranches] = useState<BranchInfo[]>([])
	const [showRemoteBranches, setShowRemoteBranches] = useState(false)
	const [branchSearch, setBranchSearch] = useState('')
	const [branchesLoading, setBranchesLoading] = useState(false)

	// .gitignore state
	const [gitignoreEntries, setGitignoreEntries] = useState<GitignoreEntry[]>([])
	const [showGitignore, setShowGitignore] = useState(false)

	// Operation state
	const [isCreating, setIsCreating] = useState(false)
	const [validationError, setValidationError] = useState<string | null>(null)

	const projectPath = project?.path ?? ''
	const isGitRepo = project?.isGitRepo ?? false

	// Sanitize branch name for git (replace invalid chars with dashes)
	const sanitizeBranchName = (name: string): string => {
		return name
			.replace(/[^a-zA-Z0-9/_.-]/g, '-')
			.replace(/--+/g, '-')
			.replace(/^-|-$/g, '')
	}

	// Auto-fill worktree name from branch name
	useEffect(() => {
		if (branchType === 'new' && newBranchName) {
			setWorktreeName(sanitizeBranchName(newBranchName))
		} else if (branchType === 'existing' && selectedBranch) {
			// Extract branch name after last /
			const name = selectedBranch.split('/').pop() ?? selectedBranch
			setWorktreeName(name)
		}
	}, [branchType, newBranchName, selectedBranch])

	// Reset form when modal opens
	useEffect(() => {
		if (isOpen) {
			setBranchType('new')
			setSelectedBranch('')
			setNewBranchName('')
			setStartRef('')
			setWorktreeName('')
			setBranchSearch('')
			setShowRemoteBranches(false)
			setValidationError(null)
			setIsCreating(false)
			setGitignoreEntries([
				...SENSITIVE_GITIGNORE_PATTERNS.map((p) => ({ ...p, copy: false })),
				...COMMON_GITIGNORE_PATTERNS.map((p) => ({ ...p, copy: true })),
			])
		}
	}, [isOpen])

	// Fetch branches when modal opens
	useEffect(() => {
		if (!isOpen || !projectPath) return

		const fetchBranches = async () => {
			setBranchesLoading(true)
			try {
				const result = await worktreeApi.branches(projectPath)
				if (result.success && result.data) {
					setBranches(result.data)
				} else {
					setBranches([])
				}
			} catch {
				setBranches([])
			} finally {
				setBranchesLoading(false)
			}
		}
		void fetchBranches()
	}, [isOpen, projectPath])

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

	// Validate form
	const validate = useCallback((): string | null => {
		if (!isGitRepo) return 'Project is not a git repository'
		if (isWorktreeOperationLocked) return 'Another worktree operation is in progress'

		// Check if branch already has a worktree
		const branch = branchType === 'existing' ? selectedBranch : sanitizeBranchName(newBranchName)
		const existingWorktree = project?.worktrees?.find(
			(w: Worktree) => w.branch === branch || w.name === worktreeName,
		)
		if (existingWorktree) {
			return `A worktree for branch "${branch}" already exists`
		}

		if (branchType === 'new') {
			if (!newBranchName.trim()) return 'Branch name is required'
			const sanitized = sanitizeBranchName(newBranchName)
			if (sanitized !== newBranchName) {
				// Will be sanitized automatically — not an error
			}
		} else {
			if (!selectedBranch) return 'Select a branch'
		}

		if (!worktreeName.trim()) return 'Worktree name is required'

		// Check for path length (Windows MAX_PATH = 260)
		const targetPath = `${projectPath}/.termul/worktrees/${worktreeName}/`
		if (targetPath.length > 240) return 'Path too long'

		return null
	}, [isGitRepo, isWorktreeOperationLocked, branchType, selectedBranch, newBranchName, worktreeName, project])

	// Pre-check before modal can proceed
	const canProceed = isGitRepo && !isWorktreeOperationLocked

	// Filter branches for search
	const filteredBranches = branches.filter((b) => {
		if (!showRemoteBranches && b.isRemote) return false
		if (branchSearch && !b.name.toLowerCase().includes(branchSearch.toLowerCase())) return false
		return true
	})

	// Local branches first, then remote
	const sortedBranches = [...filteredBranches].sort((a, b) => {
		if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
		if (a.isCurrent) return -1
		if (b.isCurrent) return 1
		return a.name.localeCompare(b.name)
	})

	const handleCreate = useCallback(async () => {
		const error = validate()
		if (error) {
			setValidationError(error)
			return
		}

		setIsCreating(true)
		setValidationError(null)
		setWorktreeOperationLock(true)

		try {
			const branch = branchType === 'existing'
				? selectedBranch
				: sanitizeBranchName(newBranchName)

			const result = await worktreeApi.create({
				projectPath,
				name: worktreeName,
				branch,
				isNewBranch: branchType === 'new',
				startRef: startRef || undefined,
			})

			if (result.success && result.data) {
				const newWorktree: Worktree = {
					id: crypto.randomUUID(),
					name: result.data.name,
					branch: result.data.branch,
					path: result.data.path,
					createdAt: new Date().toISOString(),
				}
				addWorktree(projectId, newWorktree)
				toast({
					title: 'Worktree created',
					description: `"${result.data.name}" created successfully on branch "${result.data.branch}".`,
				})
				onClose()
			} else {
				setValidationError(!result.success ? result.error : 'Failed to create worktree')
				toast({
					title: 'Failed to create worktree',
					description: !result.success ? result.error : 'Unknown error',
					variant: 'destructive',
				})
			}
		} catch (err) {
			const msg = String(err)
			setValidationError(msg)
			toast({
				title: 'Error creating worktree',
				description: msg,
				variant: 'destructive',
			})
		} finally {
			setIsCreating(false)
			setWorktreeOperationLock(false)
		}
	}, [
		validate,
		branchType,
		selectedBranch,
		newBranchName,
		worktreeName,
		startRef,
		projectPath,
		projectId,
		addWorktree,
		setWorktreeOperationLock,
		onClose,
	])

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLDivElement>) => {
			if (e.key === 'Enter' && canProceed && worktreeName.trim()) {
				e.preventDefault()
				void handleCreate()
			} else if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
			}
		},
		[canProceed, worktreeName, handleCreate, onClose],
	)

	// Path preview
	const pathPreview = projectPath
		? `${projectPath}/.termul/worktrees/${worktreeName || '<name>'}/`
		: '<select a project>'

	if (!project) return null

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
						className="bg-card rounded-lg shadow-2xl w-[520px] border border-border overflow-hidden"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={handleKeyDown}
					>
						{/* Header */}
						<div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
							<div className="flex items-center gap-2">
								<GitBranch size={14} className="text-primary" />
								<h3 className="text-sm font-semibold text-foreground">New Worktree</h3>
							</div>
							<button
								onClick={onClose}
								className="text-muted-foreground hover:text-foreground transition-colors"
							>
								<X size={14} />
							</button>
						</div>

						{/* Content */}
						<div className="p-4 space-y-4">
							{/* Project name (read-only) */}
							<div>
								<label className="block text-xs font-medium text-muted-foreground mb-1">
									Project
								</label>
								<input
									type="text"
									value={project.name}
									readOnly
									className="w-full bg-secondary/50 border border-border rounded px-3 py-1.5 text-sm text-muted-foreground cursor-not-allowed"
								/>
							</div>

							{/* Branch type toggle */}
							<div>
								<label className="block text-xs font-medium text-muted-foreground mb-1">
									Branch Type
								</label>
								<div className="flex gap-2">
									<button
										onClick={() => setBranchType('new')}
										className={cn(
											'flex-1 px-3 py-1.5 text-xs font-medium rounded border transition-colors',
											branchType === 'new'
												? 'bg-primary text-primary-foreground border-primary'
												: 'bg-secondary text-muted-foreground border-border hover:bg-muted',
										)}
									>
										New Branch
									</button>
									<button
										onClick={() => setBranchType('existing')}
										className={cn(
											'flex-1 px-3 py-1.5 text-xs font-medium rounded border transition-colors',
											branchType === 'existing'
												? 'bg-primary text-primary-foreground border-primary'
												: 'bg-secondary text-muted-foreground border-border hover:bg-muted',
										)}
									>
										Existing Branch
									</button>
								</div>
							</div>

							{/* Branch picker for existing branches */}
							{branchType === 'existing' && (
								<div>
									<label className="block text-xs font-medium text-muted-foreground mb-1">
										Select Branch
									</label>
									{branchesLoading ? (
										<div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
											<Loader2 size={14} className="animate-spin" />
											Loading branches...
										</div>
									) : (
										<>
											{/* Branch search */}
											<div className="relative mb-2">
												<Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
												<input
													type="text"
													value={branchSearch}
													onChange={(e) => setBranchSearch(e.target.value)}
													placeholder="Search branches..."
													className="w-full bg-secondary border border-border rounded pl-7 pr-3 py-1 text-xs text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
												/>
											</div>
											{/* Remote toggle */}
											<label className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground cursor-pointer">
												<input
													type="checkbox"
													checked={showRemoteBranches}
													onChange={(e) => setShowRemoteBranches(e.target.checked)}
													className="rounded border-border"
												/>
												Show remote branches
											</label>
											{/* Branch list */}
											<div className="max-h-32 overflow-y-auto border border-border rounded bg-secondary/50">
												{sortedBranches.length === 0 ? (
													<div className="p-2 text-xs text-muted-foreground text-center">
														No branches found
													</div>
												) : (
													sortedBranches.map((branch) => (
														<button
															key={branch.name}
															onClick={() => setSelectedBranch(branch.name)}
															className={cn(
																'w-full flex items-center px-3 py-1 text-xs transition-colors text-left',
																selectedBranch === branch.name
																	? 'bg-primary/15 text-foreground'
																	: 'text-muted-foreground hover:bg-sidebar-accent/50',
															)}
														>
															<GitBranch size={10} className="mr-1.5 flex-shrink-0" />
															<span className="truncate flex-1">{branch.name}</span>
															{branch.isCurrent && (
																<span className="text-[10px] text-primary ml-1">current</span>
															)}
															{branch.isRemote && (
																<span className="text-[10px] text-muted-foreground ml-1">remote</span>
															)}
														</button>
													))
												)}
											</div>
										</>
									)}
								</div>
							)}

							{/* New branch name */}
							{branchType === 'new' && (
								<>
									<div>
										<label className="block text-xs font-medium text-muted-foreground mb-1">
											Branch Name
										</label>
										<input
											type="text"
											value={newBranchName}
											onChange={(e) => setNewBranchName(e.target.value)}
											placeholder="feature/my-feature"
											className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
											autoFocus
										/>
										{newBranchName && sanitizeBranchName(newBranchName) !== newBranchName && (
											<p className="text-[10px] text-muted-foreground mt-0.5">
												Will be sanitized to: {sanitizeBranchName(newBranchName)}
											</p>
										)}
									</div>
									<div>
										<label className="block text-xs font-medium text-muted-foreground mb-1">
											Start Reference <span className="text-muted-foreground/60">(optional)</span>
										</label>
										<input
											type="text"
											value={startRef}
											onChange={(e) => setStartRef(e.target.value)}
											placeholder="HEAD, main, or a commit hash"
											className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
										/>
										<p className="text-[10px] text-muted-foreground mt-0.5">
											Defaults to HEAD if not specified
										</p>
									</div>
								</>
							)}

							{/* Worktree name */}
							<div>
								<label className="block text-xs font-medium text-muted-foreground mb-1">
									Worktree Name
								</label>
								<input
									type="text"
									value={worktreeName}
									onChange={(e) => setWorktreeName(e.target.value)}
									placeholder="my-worktree"
									className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary outline-none placeholder-muted-foreground"
								/>
								<p className="text-[10px] text-muted-foreground mt-0.5">
									Auto-filled from branch name
								</p>
							</div>

							{/* Path preview */}
							<div>
								<label className="block text-xs font-medium text-muted-foreground mb-1">
									Path Preview
								</label>
								<code className="block text-[10px] text-muted-foreground bg-secondary/50 border border-border rounded px-3 py-1.5 overflow-x-auto whitespace-nowrap">
									{pathPreview}
								</code>
							</div>

							{/* .gitignore handler */}
							<div>
								<button
									onClick={() => setShowGitignore(!showGitignore)}
									className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
								>
									<GitBranch size={10} />
									.gitignore handling
									<span className="text-[10px]">{showGitignore ? '▲' : '▼'}</span>
								</button>
								{showGitignore && (
									<div className="mt-2 border border-border rounded p-3 bg-secondary/30 space-y-1.5">
										{/* Security-sensitive patterns */}
										<div className="mb-2">
											<div className="flex items-center gap-1 text-[10px] text-amber-500 mb-1">
												<AlertTriangle size={10} />
												Security-sensitive (default: don't copy)
											</div>
											{gitignoreEntries
												.filter((e) => SENSITIVE_GITIGNORE_PATTERNS.some((s) => s.pattern === e.pattern))
												.map((entry, idx) => (
													<label key={entry.pattern} className="flex items-center gap-2 text-xs cursor-pointer">
														<input
															type="checkbox"
															checked={entry.copy}
															onChange={() => {
																const updated = [...gitignoreEntries]
																const realIdx = gitignoreEntries.findIndex((e) => e.pattern === entry.pattern)
																updated[realIdx] = { ...updated[realIdx], copy: !updated[realIdx].copy }
																setGitignoreEntries(updated)
															}}
															className="rounded border-border"
														/>
														<span className="text-muted-foreground">{entry.label}</span>
														{!entry.copy && (
															<span className="text-[10px] text-amber-500">⚠ won't copy</span>
														)}
													</label>
												))}
										</div>
										{/* Common patterns */}
										<div>
											<div className="text-[10px] text-muted-foreground mb-1">
												Common patterns (default: copy)
											</div>
											{gitignoreEntries
												.filter((e) => COMMON_GITIGNORE_PATTERNS.some((s) => s.pattern === e.pattern))
												.map((entry, idx) => (
													<label key={entry.pattern} className="flex items-center gap-2 text-xs cursor-pointer">
														<input
															type="checkbox"
															checked={entry.copy}
															onChange={() => {
																const updated = [...gitignoreEntries]
																const realIdx = gitignoreEntries.findIndex((e) => e.pattern === entry.pattern)
																updated[realIdx] = { ...updated[realIdx], copy: !updated[realIdx].copy }
																setGitignoreEntries(updated)
															}}
															className="rounded border-border"
														/>
														<span className="text-muted-foreground">{entry.label}</span>
													</label>
												))}
										</div>
									</div>
								)}
							</div>

							{/* Validation error */}
							{validationError && (
								<div className="flex items-start gap-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
									<AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
									{validationError}
								</div>
							)}

							{/* Pre-check warnings */}
							{!isGitRepo && (
								<div className="flex items-start gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
									<AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
									This project is not a git repository. Worktrees require a git repo.
								</div>
							)}
						</div>

						{/* Footer */}
						<div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
							<button
								onClick={onClose}
								className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
							>
								Cancel
							</button>
							<button
								onClick={() => void handleCreate()}
								disabled={!canProceed || isCreating || !worktreeName.trim()}
								className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 shadow-md shadow-primary/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
							>
								{isCreating && <Loader2 size={12} className="animate-spin" />}
								{isCreating ? 'Creating...' : 'Create Worktree'}
							</button>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	)
}