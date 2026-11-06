#!/usr/bin/env bun

/**
 * Post-build 404 writer.
 *
 * The SSG build prerenders the catch-all route at /404 (dist/404/index.html).
 * Cloudflare Pages only serves a custom 404 (with a real 404 status) when the
 * file is dist/404.html, so move it there and drop the /404 directory so that
 * /404 itself is not served as a 200 page.
 */

import { existsSync, renameSync, rmSync } from 'node:fs';

const BUILD_DIR = 'dist';
const source = `${BUILD_DIR}/404/index.html`;
const target = `${BUILD_DIR}/404.html`;

if (!existsSync(source)) {
	console.error(`Missing ${source}; the /404 route was not prerendered.`);
	process.exit(1);
}

renameSync(source, target);
rmSync(`${BUILD_DIR}/404`, { recursive: true, force: true });
console.log(`✓ ${target} written`);
