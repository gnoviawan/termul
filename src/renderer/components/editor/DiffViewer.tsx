/**
 * Simple unified-diff parser and viewer component.
 *
 * Accepts a raw unified diff string and renders it with color-coded
 * line-by-line output (red for removed, green for added).
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'

interface DiffLine {
	type: 'context' | 'added' | 'removed' | 'header' | 'hunk' | 'meta'
	content: string
}

function parseUnifiedDiff(diff: string): DiffLine[] {
	if (!diff) return []

	const lines = diff.split('\n')
	const result: DiffLine[] = []

	for (const line of lines) {
		if (line.startsWith('diff --git') || line.startsWith('diff --cc')) {
			result.push({ type: 'meta', content: line })
		} else if (
			line.startsWith('index ') ||
			line.startsWith('new file') ||
			line.startsWith('deleted file') ||
			line.startsWith('Binary files')
		) {
			result.push({ type: 'meta', content: line })
		} else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
			result.push({ type: 'header', content: line })
		} else if (line.startsWith('@@')) {
			result.push({ type: 'hunk', content: line })
		} else if (line.startsWith('+')) {
			result.push({ type: 'added', content: line.slice(1) })
		} else if (line.startsWith('-')) {
			result.push({ type: 'removed', content: line.slice(1) })
		} else if (line.startsWith(' ')) {
			result.push({ type: 'context', content: line.slice(1) })
		} else if (line.trim()) {
			result.push({ type: 'context', content: line })
		}
	}

	return result
}

interface DiffViewerProps {
	diff: string
	className?: string
}

export function DiffViewer({ diff, className }: DiffViewerProps): React.JSX.Element {
	const lines = useMemo(() => parseUnifiedDiff(diff), [diff])

	if (lines.length === 0) {
		return (
			<div
				className={cn(
					'flex items-center justify-center h-full text-sm text-muted-foreground',
					className,
				)}
			>
				No changes to display
			</div>
		)
	}

	return (
		<div className={cn('font-mono text-xs overflow-auto h-full', className)}>
			{lines.map((line, i) => (
				<div
					key={i}
					className={cn(
						'px-3 py-0 leading-5 whitespace-pre',
						line.type === 'added' &&
							'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
						line.type === 'removed' &&
							'bg-red-500/10 text-red-600 dark:text-red-400',
						line.type === 'header' && 'text-muted-foreground font-semibold',
						line.type === 'hunk' && 'text-blue-500 bg-blue-500/5',
						line.type === 'meta' && 'text-muted-foreground italic',
						line.type === 'context' && 'text-foreground/70',
					)}
				>
					<span className="inline-block w-5 text-right mr-3 select-none opacity-40">
						{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
					</span>
					{line.content}
				</div>
			))}
		</div>
	)
}
