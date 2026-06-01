/**
 * Sync ACP Registry icons: fetches registry.json, downloads each agent's icon
 * SVG to src/renderer/assets/agent-icons/acp/{id}.svg, normalizes
 * fill/stroke to currentColor, and writes acp/manifest.json.
 *
 * Usage: node scripts/sync-acp-icons.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ICONS_DIR = join(ROOT, 'src', 'renderer', 'assets', 'agent-icons', 'acp')
const MANIFEST_PATH = join(ICONS_DIR, 'manifest.json')
const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

async function fetchJSON(url) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
	return res.json()
}

async function fetchText(url) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
	return res.text()
}

/**
 * Normalize SVG so it works with currentColor:
 * - Strip fixed width/height (CSS sizes it)
 * - Replace hardcoded fill colors with currentColor
 * - Replace hardcoded stroke colors with currentColor
 * - Keep viewBox for aspect ratio
 */
function normalizeSvg(svg) {
	let s = svg
	// Strip fixed width/height attributes
	s = s.replace(/\s+width="[^"]*"/g, '')
	s = s.replace(/\s+height="[^"]*"/g, '')
	// Replace fill="none" is fine, leave it.
	// Replace fill="<color>" with fill="currentColor" (but not "none" or "inherit")
	s = s.replace(/\sfill="(?!none|inherit|currentColor)[^"]*"/g, ' fill="currentColor"')
	// Replace stroke="<color>" with stroke="currentColor"
	s = s.replace(/\sstroke="(?!none|inherit|currentColor)[^"]*"/g, ' stroke="currentColor"')
	return s
}

async function main() {
	console.log('Fetching ACP registry...')
	const registry = await fetchJSON(REGISTRY_URL)
	const agents = registry.agents || []
	console.log(`Found ${agents.length} agents in registry`)

	mkdirSync(ICONS_DIR, { recursive: true })

	const manifest = []

	for (const agent of agents) {
		const id = agent.id
		const name = agent.name || id
		const iconUrl = agent.icon

		if (!iconUrl) {
			console.log(`  SKIP ${id}: no icon URL`)
			continue
		}

		const filename = `${id}.svg`
		const filepath = join(ICONS_DIR, filename)

		try {
			console.log(`  Downloading ${id} icon: ${iconUrl}`)
			let svg = await fetchText(iconUrl)
			svg = normalizeSvg(svg)
			writeFileSync(filepath, svg, 'utf8')
			manifest.push({ id, name, file: filename })
		} catch (err) {
			console.warn(`  FAIL ${id}: ${err.message}`)
		}
	}

	// Sort manifest by id for deterministic output
	manifest.sort((a, b) => a.id.localeCompare(b.id))
	writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
	console.log(`\nDone! Downloaded ${manifest.length} icons.`)
	console.log(`Manifest written to ${MANIFEST_PATH}`)
}

main().catch((err) => {
	console.error('Fatal:', err)
	process.exit(1)
})