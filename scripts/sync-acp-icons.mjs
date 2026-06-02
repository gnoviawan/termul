/**
 * Sync ACP Registry icons: fetches registry.json, downloads each agent's icon
 * SVG to src/renderer/assets/agent-icons/acp/{id}.svg, normalizes
 * fill/stroke to currentColor, and writes acp/manifest.json.
 *
 * Maintainer-only offline asset sync (not shipped in the app runtime).
 * Network payloads are validated before any filesystem write.
 *
 * Usage: node scripts/sync-acp-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ICONS_DIR = join(ROOT, 'src', 'renderer', 'assets', 'agent-icons', 'acp')
const MANIFEST_PATH = join(ICONS_DIR, 'manifest.json')
const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/
const SAFE_DISPLAY_NAME = /^[\p{L}\p{N}\s._-]+$/u
const FETCH_TIMEOUT_MS = 10_000
const MAX_SVG_BYTES = 256 * 1024

function isSafeIconPath(filepath) {
	const iconsRoot = resolve(ICONS_DIR)
	const resolved = resolve(filepath)
	return resolved === iconsRoot || resolved.startsWith(`${iconsRoot}${sep}`)
}

function isAllowedHttpsUrl(urlString) {
	try {
		const url = new URL(urlString)
		return url.protocol === 'https:'
	} catch {
		return false
	}
}

async function fetchWithTimeout(url, options = {}) {
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		return await fetch(url, { ...options, signal: controller.signal })
	} catch (err) {
		if (err?.name === 'AbortError') {
			throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`)
		}
		throw err
	} finally {
		clearTimeout(timeoutId)
	}
}

async function fetchJSON(url) {
	const res = await fetchWithTimeout(url)
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
	return res.json()
}

async function fetchSvgText(url) {
	const res = await fetchWithTimeout(url)
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
	const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
	if (contentType && !contentType.includes('svg') && !contentType.includes('xml')) {
		throw new Error(`Unexpected content-type for ${url}: ${contentType}`)
	}
	const text = await res.text()
	if (text.length > MAX_SVG_BYTES) {
		throw new Error(`SVG payload too large (${text.length} bytes) from ${url}`)
	}
	return text
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
	s = s.replace(/\s+width="[^"]*"/g, '')
	s = s.replace(/\s+height="[^"]*"/g, '')
	s = s.replace(/\sfill="(?!none|inherit|currentColor)[^"]*"/g, ' fill="currentColor"')
	s = s.replace(/\sstroke="(?!none|inherit|currentColor)[^"]*"/g, ' stroke="currentColor"')
	return s
}

/** Validate untrusted SVG before writing to disk. Returns trusted normalized SVG. */
function validateAndNormalizeSvg(untrusted) {
	if (typeof untrusted !== 'string' || untrusted.length === 0) {
		throw new Error('Empty SVG payload')
	}
	if (untrusted.length > MAX_SVG_BYTES) {
		throw new Error('SVG payload too large')
	}
	const rootTag = untrusted.match(/<svg\b[^>]*>/i)?.[0]
	if (!rootTag) {
		throw new Error('Payload is not an SVG document')
	}
	if (!/\bviewBox\s*=/i.test(rootTag)) {
		throw new Error('SVG root is missing viewBox')
	}
	if (/<script\b/i.test(untrusted) || /\bon\w+\s*=/i.test(untrusted)) {
		throw new Error('SVG contains disallowed content')
	}
	return normalizeSvg(untrusted)
}

function sanitizeDisplayName(id, rawName) {
	const name = String(rawName ?? id).trim().slice(0, 120)
	if (!name || !SAFE_DISPLAY_NAME.test(name)) {
		return id
	}
	return name
}

function buildManifestEntry(id, displayName, filename) {
	if (!SAFE_AGENT_ID.test(id)) {
		throw new Error(`Invalid manifest id: ${id}`)
	}
	const expectedFile = `${id}.svg`
	if (filename !== expectedFile) {
		throw new Error(`Invalid manifest filename for ${id}`)
	}
	return {
		id,
		name: sanitizeDisplayName(id, displayName),
		file: expectedFile,
	}
}

function writeTrustedSvg(filepath, trustedSvg) {
	if (!isSafeIconPath(filepath)) {
		throw new Error(`Unsafe icon path: ${filepath}`)
	}
	writeFileSync(filepath, trustedSvg, 'utf8')
}

function writeTrustedManifest(entries) {
	if (!isSafeIconPath(MANIFEST_PATH)) {
		throw new Error(`Unsafe manifest path: ${MANIFEST_PATH}`)
	}
	const safeEntries = entries.map((entry) =>
		buildManifestEntry(entry.id, entry.name, entry.file),
	)
	writeFileSync(MANIFEST_PATH, JSON.stringify(safeEntries, null, 2) + '\n', 'utf8')
}

async function main() {
	console.log('Fetching ACP registry...')
	const registry = await fetchJSON(REGISTRY_URL)
	const agents = Array.isArray(registry.agents) ? registry.agents : []
	console.log(`Found ${agents.length} agents in registry`)

	mkdirSync(ICONS_DIR, { recursive: true })

	const manifest = []

	for (const agent of agents) {
		const id = agent.id
		const name = agent.name || id
		const iconUrl = agent.icon

		if (!id || !SAFE_AGENT_ID.test(id)) {
			console.warn(`  SKIP ${id ?? '<missing id>'}: invalid agent id`)
			continue
		}

		if (!iconUrl || !isAllowedHttpsUrl(iconUrl)) {
			console.log(`  SKIP ${id}: missing or non-https icon URL`)
			continue
		}

		const filename = `${id}.svg`
		const filepath = join(ICONS_DIR, filename)
		if (!isSafeIconPath(filepath)) {
			console.warn(`  SKIP ${id}: unsafe icon path`)
			continue
		}

		try {
			console.log(`  Downloading ${id} icon: ${iconUrl}`)
			const untrustedSvg = await fetchSvgText(iconUrl)
			const trustedSvg = validateAndNormalizeSvg(untrustedSvg)
			writeTrustedSvg(filepath, trustedSvg)
			manifest.push(buildManifestEntry(id, name, filename))
		} catch (err) {
			console.warn(`  FAIL ${id}: ${err.message}`)
		}
	}

	manifest.sort((a, b) => a.id.localeCompare(b.id))
	writeTrustedManifest(manifest)
	console.log(`\nDone! Downloaded ${manifest.length} icons.`)
	console.log(`Manifest written to ${MANIFEST_PATH}`)
}

main().catch((err) => {
	console.error('Fatal:', err)
	process.exit(1)
})
