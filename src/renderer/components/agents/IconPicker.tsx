import { useMemo, useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
	BUNDLED_ICON_CATALOG,
	findBundledIconBySvg,
	normalizeIconSvg,
	type BundledIconEntry,
} from '@/lib/agents/agent-icon-catalog'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'

interface IconPickerProps {
	value: string
	onChange: (svg: string) => void
}

function InlineBundledIcon({
	entry,
	className,
}: {
	entry: BundledIconEntry
	className?: string
}): React.JSX.Element {
	return (
		<span
			className={cn(
				'inline-flex [&_svg]:h-full [&_svg]:w-full',
				entry.pickerColor,
				className,
			)}
			dangerouslySetInnerHTML={{ __html: normalizeIconSvg(entry.svg) }}
		/>
	)
}

/**
 * Modal icon picker — compact trigger button, full grid in a dialog.
 * All icons are bundled offline; each has a distinct tint in the grid.
 */
export function IconPicker({ value, onChange }: IconPickerProps): React.JSX.Element {
	const [open, setOpen] = useState(false)

	const selectedEntry = useMemo(() => findBundledIconBySvg(value), [value])

	const handleSelect = (svg: string) => {
		onChange(svg)
		setOpen(false)
	}

	const triggerIcon = selectedEntry ? (
		<div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary/40 p-1.5 hover:bg-secondary transition-colors">
			<InlineBundledIcon entry={selectedEntry} className="h-5 w-5" />
		</div>
	) : (
		<div className="flex h-9 w-9 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground hover:bg-secondary/60 transition-colors">
			<Pencil size={14} />
		</div>
	)

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="shrink-0"
				title="Choose icon"
			>
				{triggerIcon}
			</button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-[380px]">
					<DialogHeader>
						<DialogTitle className="text-sm">Choose icon</DialogTitle>
					</DialogHeader>

					<div className="grid grid-cols-6 gap-2 py-2">
						{/* "No icon" option */}
						<button
							type="button"
							onClick={() => handleSelect('')}
							className={cn(
								'flex h-9 w-9 items-center justify-center rounded-md border text-xs text-muted-foreground transition-colors',
								!value
									? 'border-primary/60 bg-primary/10 text-foreground ring-2 ring-primary/30'
									: 'border-border hover:bg-secondary',
							)}
							title="No icon"
						>
							—
						</button>

						{BUNDLED_ICON_CATALOG.map((entry) => {
							const isSelected = selectedEntry?.key === entry.key
							return (
								<button
									key={entry.key}
									type="button"
									onClick={() => handleSelect(entry.svg)}
									className={cn(
										'relative flex h-9 w-9 items-center justify-center rounded-md border p-1.5 transition-colors',
										isSelected
											? 'border-primary/60 bg-primary/10 ring-2 ring-primary/30'
											: 'border-border hover:bg-secondary',
									)}
									title={entry.label}
								>
									<InlineBundledIcon entry={entry} className="h-5 w-5" />
									{isSelected && (
										<Check
											size={10}
											className="absolute -right-0.5 -top-0.5 text-primary"
										/>
									)}
								</button>
							)
						})}
					</div>
				</DialogContent>
			</Dialog>
		</>
	)
}
