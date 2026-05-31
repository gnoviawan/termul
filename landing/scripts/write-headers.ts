#!/usr/bin/env bun

/**
 * Post-build headers writer + CSP hash injector.
 *
 * Reads scripts/_headers.yaml — a structured YAML file describing routes and
 * headers. Supports three header value formats:
 *
 *   Content-Security-Policy  — object of directive → source[] | true (flag-only)
 *   Permissions-Policy       — object of feature   → allowlist[]
 *   Everything else          — plain string (passed through as-is)
 *
 * Deletion headers (Cloudflare Pages "! Header-Name" syntax) are represented
 * by a null YAML value, e.g. `"! Access-Control-Allow-Origin": ~`.
 *
 * {{CSP_SCRIPT_HASHES}} in any source list is replaced at build time with the
 * SHA-256 hashes of all inline <script> blocks found in build/index.html.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = resolve(__dirname, '_headers.yaml');
const BUILD_DIR = 'dist';

// ─── Types ────────────────────────────────────────────────────────────────────

type CspValue = Record<string, string[] | true>;
type PermissionsValue = Record<string, string[]>;

interface RouteConfig {
	path: string;
	headers: Record<string, string | CspValue | PermissionsValue | null>;
}

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

function sha256(content: string): string {
	return `'sha256-${createHash('sha256').update(content).digest('base64')}'`;
}

// ─── Header value serializers ─────────────────────────────────────────────────

function serializeCSP(directives: CspValue): string {
	return Object.entries(directives)
		.map(([directive, sources]) =>
			sources === true
				? directive // flag-only, e.g. upgrade-insecure-requests
				: `${directive} ${sources.join(' ')}`,
		)
		.join('; ');
}

function serializePermissionsPolicy(features: PermissionsValue): string {
	return Object.entries(features)
		.map(([feature, allowlist]) =>
			allowlist.length === 0
				? `${feature}=()`
				: `${feature}=(${allowlist.join(' ')})`,
		)
		.join(', ');
}

function serializeValue(
	name: string,
	value: string | CspValue | PermissionsValue,
): string {
	if (name === 'Content-Security-Policy')
		return serializeCSP(value as CspValue);
	if (name === 'Permissions-Policy')
		return serializePermissionsPolicy(value as PermissionsValue);
	return String(value);
}

// ─── Inline script hashes from index.html ────────────────────────────────────

const html = readFileSync(`${BUILD_DIR}/index.html`, 'utf-8');
const scriptHashes: string[] = [];

for (const match of html.matchAll(
	/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi,
)) {
	const content = match[1];
	if (content.trim()) scriptHashes.push(sha256(content));
}

console.log('  Inline script hashes:', scriptHashes);

// ─── Parse config and emit _headers ──────────────────────────────────────────

const routes = load(readFileSync(CONFIG_FILE, 'utf-8')) as RouteConfig[];
const lines: string[] = [];

for (const { path, headers } of routes) {
	lines.push(path);

	for (const [name, value] of Object.entries(headers)) {
		if (value === null || value === undefined) {
			// Deletion directive — emit bare name (e.g. "! Access-Control-Allow-Origin")
			lines.push(`  ${name}`);
			continue;
		}

		let serialized = serializeValue(name, value);

		// Inject computed hashes, or cleanly remove the placeholder if there are none
		serialized =
			scriptHashes.length > 0
				? serialized.replace('{{CSP_SCRIPT_HASHES}}', scriptHashes.join(' '))
				: serialized.replace(' {{CSP_SCRIPT_HASHES}}', '');

		lines.push(`  ${name}: ${serialized}`);
	}

	lines.push(''); // blank line between route blocks
}

writeFileSync(`${BUILD_DIR}/_headers`, lines.join('\n'));
console.log(`✓ _headers written to ${BUILD_DIR}/_headers`);
