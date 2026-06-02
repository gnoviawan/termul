import DOMPurify from 'dompurify'

/** Strip width/height from the root `<svg>` tag only. */
export function normalizeRootIconSvg(svg: string): string {
	return svg.replace(/<svg\b[^>]*>/i, (tag) =>
		tag.replace(/\s+width="[^"]*"/g, '').replace(/\s+height="[^"]*"/g, ''),
	)
}

/** Sanitize inline agent SVG before rendering with dangerouslySetInnerHTML. */
export function sanitizeInlineAgentSvg(svg: string): string | null {
	const cleaned = DOMPurify.sanitize(svg, {
		USE_PROFILES: { svg: true, svgFilters: true },
	})
	const normalized = normalizeRootIconSvg(cleaned)
	if (!/^\s*<svg\b/i.test(normalized)) return null
	if (!/viewBox/i.test(normalized)) return null
	return normalized
}
