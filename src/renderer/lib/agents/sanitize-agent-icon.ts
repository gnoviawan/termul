import DOMPurify from 'dompurify'

/** Strip width/height from the root `<svg>` tag only. */
export function normalizeRootIconSvg(svg: string): string {
	return svg.replace(/<svg\b[^>]*>/i, (tag) =>
		tag.replace(/\s+width="[^"]*"/g, '').replace(/\s+height="[^"]*"/g, ''),
	)
}

function rootSvgOpeningTag(normalized: string): string | null {
	const match = normalized.match(/^\s*<svg\b[^>]*>/i)
	return match?.[0] ?? null
}

/** Sanitize inline agent SVG before rendering with dangerouslySetInnerHTML. */
export function sanitizeInlineAgentSvg(svg: string): string | null {
	const cleaned = DOMPurify.sanitize(svg, {
		USE_PROFILES: { svg: true, svgFilters: true },
	})
	const normalized = normalizeRootIconSvg(cleaned)
	const rootTag = rootSvgOpeningTag(normalized)
	if (!rootTag) return null
	if (!/\bviewBox\s*=/i.test(rootTag)) return null
	return normalized
}
