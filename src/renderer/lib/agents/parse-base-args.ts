/**
 * Parse a human-entered base-args field into argv tokens, preserving quoted
 * segments and paths that contain spaces.
 */
export function parseBaseArgsInput(input: string): string[] {
	const trimmed = input.trim()
	if (!trimmed) return []

	const args: string[] = []
	let current = ''
	let quote: '"' | "'" | null = null

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]
		if (quote) {
			if (ch === quote) {
				quote = null
				continue
			}
			current += ch
			continue
		}

		if (ch === '"' || ch === "'") {
			quote = ch
			continue
		}

		if (/\s/.test(ch)) {
			if (current) {
				args.push(current)
				current = ''
			}
			continue
		}

		current += ch
	}

	if (current) args.push(current)
	return args
}
