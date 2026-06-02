import { describe, expect, test } from 'bun:test';
import {
	extractInlineScriptHashes,
	injectCspScriptHashes,
	serializeCSP,
} from './write-headers';

describe('write-headers', () => {
	test('extractInlineScriptHashes ignores external scripts', () => {
		const html = `
			<script src="/app.js"></script>
			<script>console.log('inline')</script>
		`;
		const hashes = extractInlineScriptHashes(html);
		expect(hashes).toHaveLength(1);
		expect(hashes[0]).toMatch(/^'sha256-/);
	});

	test('injectCspScriptHashes replaces placeholder with joined hashes', () => {
		const csp = serializeCSP({
			'script-src': ["'self'", '{{CSP_SCRIPT_HASHES}}', 'https://example.com'],
		});
		const hashes = ["'sha256-abc='", "'sha256-def='"];
		const result = injectCspScriptHashes(csp, hashes);

		expect(result).toContain("'sha256-abc='");
		expect(result).toContain("'sha256-def='");
		expect(result).not.toContain('{{CSP_SCRIPT_HASHES}}');
	});

	test('injectCspScriptHashes strips placeholder when no hashes', () => {
		const csp = serializeCSP({
			'script-src': ["'self'", '{{CSP_SCRIPT_HASHES}}'],
		});
		const result = injectCspScriptHashes(csp, []);

		expect(result).toBe("script-src 'self'");
		expect(result).not.toContain('{{CSP_SCRIPT_HASHES}}');
	});
});
