import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Pencil } from 'lucide-react'
import { BUILT_IN_AGENTS } from '@/lib/agents/agent-registry'
import { fetchAcpRegistry } from '@/lib/agents/acp-registry-catalog'

/**
 * An icon source entry for the picker. Each entry has a stable key, display
 * label, and the resolved SVG markup (either bundled inline or fetched).
 */
export interface IconSource {
	key: string
	label: string
	svg: string
}

/**
 * Bundled icon sources derived from the built-in agent registry. These are
 * always available (offline) and use inline SVG with `currentColor`.
 */
export function getBundledIconSources(): IconSource[] {
	return BUILT_IN_AGENTS.filter((a) => a.icon)
		.map((a) => ({
			key: `builtin:${a.id}`,
			label: a.name,
			svg: a.icon!,
		}))
}

/**
 * React component that lets the user pick an icon from bundled + (optionally)
 * ACP registry entries. Renders a compact grid of icons plus a "none" option.
 */
interface IconPickerProps {
	value: string
	onChange: (svg: string) => void
}

export function IconPicker({ value, onChange }: IconPickerProps): React.JSX.Element {
	const bundled = useMemo(() => getBundledIconSources(), [])
	const [registryIcons, setRegistryIcons] = useState<IconSource[]>([])
	const [showAll, setShowAll] = useState(false)

	// Lazily fetch ACP registry icons when the user expands the picker.
	useEffect(() => {
		if (!showAll) return
		let cancelled = false
		void fetchAcpRegistry(true).then((catalog) => {
			if (cancelled) return
			const entries = catalog.entries.filter((e) => e.icon)
			setRegistryIcons(
				entries.map((e) => ({
					key: `registry:${e.id}`,
					label: e.name,
					// ACP registry icons are URLs — we can't inline them, so we
					// show them as small <img> tags. The value stored is the URL.
					svg: e.icon!,
				})),
			)
		})
		return () => {
			cancelled = true
		}
	}, [showAll])

	const allIcons = useMemo(() => {
		if (!showAll) return bundled
		// When showing all, merge bundled + registry (bundled wins on key collision).
		const seen = new Set(bundled.map((b) => b.key))
		const merged = [...bundled]
		for (const r of registryIcons) {
			if (!seen.has(r.key)) {
				merged.push(r)
				seen.add(r.key)
			}
		}
		return merged
	}, [bundled, registryIcons, showAll])

	const selectedKey = useMemo(() => {
		// Match by SVG content for bundled, or by URL for registry.
		if (!value) return ''
		for (const src of allIcons) {
			if (src.svg === value) return src.key
		}
		return ''
	}, [value, allIcons])

	// Render the currently-selected icon or a placeholder.
	const currentIcon = useMemo(() => {
		if (!value) {
			return (
				<div className="flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground">
					<Pencil size={14} />
				</div>
			)
		}
		// If value looks like a URL, render as <img>
		if (value.startsWith('http://') || value.startsWith('https://')) {
			return (
				<img
					src={value}
					alt="icon"
					className="h-4 w-4"
					onError={(e) => {
						;(e.currentTarget as HTMLImageElement).style.display = 'none'
					}}
				/>
			)
		}
		// Inline SVG — normalize and render.
		const normalized = value
			.replace(/\s+width="[^"]*"/g, '')
			.replace(/\s+height="[^"]*"/g, '')
		return (
			<span
				className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-secondary/40 [&_svg]:h-4 [&_svg]:w-4"
				dangerouslySetInnerHTML={{ __html: normalized }}
			/>
		)
	}, [value])

	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				onClick={() => setShowAll(!showAll)}
				className="relative"
			>
				{currentIcon}
			</button>

			{showAll && (
				<div className="grid grid-cols-6 gap-1.5 rounded-lg border border-border p-2 bg-card">
					{/* "No icon" option */}
					<button
						type="button"
						onClick={() => {
							onChange('')
						}}
						className={`
							flex h-7 w-7 items-center justify-center rounded-md border text-[9px] text-muted-foreground transition-colors
							${!value ? 'border-primary/60 bg-primary/10 text-foreground' : 'border-border hover:bg-secondary'}
						`}
						title="No icon"
					>
						—
					</button>

					{allIcons.map((src) => {
						const isSelected = selectedKey === src.key
						const isUrl = src.svg.startsWith('http://') || src.svg.startsWith('https://')
						return (
							<button
								key={src.key}
								type="button"
								onClick={() => onChange(src.svg)}
								className={`
									relative flex h-7 w-7 items-center justify-center rounded-md border transition-colors
									${isSelected ? 'border-primary/60 bg-primary/10' : 'border-border hover:bg-secondary'}
								`}
								title={src.label}
							>
								{isUrl ? (
									<img
										src={src.svg}
										alt={src.label}
										className="h-4 w-4"
										onError={(e) => {
											;(e.currentTarget as HTMLImageElement).style.display = 'none'
										}}
									/>
								) : (
									<span
										className="inline-flex [&_svg]:h-4 [&_svg]:w-4 text-foreground/80"
										dangerouslySetInnerHTML={{
											__html: src.svg
												.replace(/\s+width="[^"]*"/g, '')
												.replace(/\s+height="[^"]*"/g, ''),
										}}
									/>
								)}
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
			)}
		</div>
	)
}