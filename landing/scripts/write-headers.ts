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
 * SHA-256 hashes of all inline <script> blocks found in dist/index.html.
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

export type CspValue = Record<string, string[] | true>;
export type PermissionsValue = Record<string, string[]>;

export interface RouteConfig {
	path: string;
	headers: Record<string, string | CspValue | PermissionsValue | null>;
}

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

export function sha256(content: string): string {
	return `'sha256-${createHash('sha256').update(content).digest('base64')}'`;
}

export function extractInlineScriptHashes(html: string): string[] {
	const scriptHashes: string[] = [];

	for (const match of html.matchAll(
		/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		const content = match[1];
		if (content.trim()) scriptHashes.push(sha256(content));
	}

	return scriptHashes;
}

// ─── Header value serializers ─────────────────────────────────────────────────

export function serializeCSP(directives: CspValue): string {
	return Object.entries(directives)
		.map(([directive, sources]) =>
			sources === true
				? directive // flag-only, e.g. upgrade-insecure-requests
				: `${directive} ${sources.join(' ')}`,
		)
		.join('; ');
}

export function serializePermissionsPolicy(features: PermissionsValue): string {
	return Object.entries(features)
		.map(([feature, allowlist]) =>
			allowlist.length === 0
				? `${feature}=()`
				: `${feature}=(${allowlist.join(' ')})`,
		)
		.join(', ');
}

export function serializeValue(
	name: string,
	value: string | CspValue | PermissionsValue,
): string {
	if (name === 'Content-Security-Policy')
		return serializeCSP(value as CspValue);
	if (name === 'Permissions-Policy')
		return serializePermissionsPolicy(value as PermissionsValue);
	return String(value);
}

export function injectCspScriptHashes(
	serialized: string,
	scriptHashes: string[],
): string {
	return scriptHashes.length > 0
		? serialized.replace('{{CSP_SCRIPT_HASHES}}', scriptHashes.join(' '))
		: serialized.replace(' {{CSP_SCRIPT_HASHES}}', '');
}

// ─── Main (postbuild) ─────────────────────────────────────────────────────────

if (import.meta.main) {
	const html = readFileSync(`${BUILD_DIR}/index.html`, 'utf-8');
	const scriptHashes = extractInlineScriptHashes(html);

	console.log('  Inline script hashes:', scriptHashes);

	const routes = load(readFileSync(CONFIG_FILE, 'utf-8')) as RouteConfig[];
	const lines: string[] = [];

	for (const { path, headers } of routes) {
		lines.push(path);

		for (const [name, value] of Object.entries(headers)) {
			if (value === null || value === undefined) {
				lines.push(`  ${name}`);
				continue;
			}

			let serialized = serializeValue(name, value);
			serialized = injectCspScriptHashes(serialized, scriptHashes);
			lines.push(`  ${name}: ${serialized}`);
		}

		lines.push('');
	}

	writeFileSync(`${BUILD_DIR}/_headers`, lines.join('\n'));
	console.log(`✓ _headers written to ${BUILD_DIR}/_headers`);
}
