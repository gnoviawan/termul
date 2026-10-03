import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRectInView } from '../src/lib/useInViewOnce';

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), '../src/styles');

function readStyle(name: string) {
  return readFileSync(join(stylesDir, name), 'utf8');
}

describe('landing motion tokens', () => {
  test('keeps the landing easing names and adds the skill scale', () => {
    const root = readStyle('transitions-root.css');

    expect(root).toContain('--duration-fast: 250ms;');
    expect(root).toContain('--ease-smooth-out:');
    expect(root).toContain('--stagger-dur: 500ms;');
    expect(root).toContain('--dropdown-close-dur: 150ms;');
    expect(root).not.toMatch(/^\s*--ease-out:/m);
    expect(root).not.toMatch(/^\s*--ease-in-out:/m);
  });

  test('ships a reduced-motion guard for every pasted transition', () => {
    const css = readStyle('transitions.css');
    const guards = css.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? [];

    expect(css).toContain('.t-stagger-line');
    expect(css).toContain('.t-dropdown');
    expect(css).toContain('.t-icon-swap');
    expect(css).toContain('.t-tabs-pill');
    expect(css).toContain('.t-avatar');
    expect(css).toContain('.t-tt');
    expect(css).toContain('.t-learn-chevron');
    expect(css).toContain('.t-text-swap');
    expect(guards.length).toBeGreaterThanOrEqual(8);
  });
});

describe('section reveal', () => {
  test('treats a block inside the viewport as already shown', () => {
    expect(isRectInView({ top: 40, bottom: 120 }, 800)).toBe(true);
    expect(isRectInView({ top: 790, bottom: 900 }, 800)).toBe(true);
  });

  test('treats a block below or above the viewport as hidden', () => {
    expect(isRectInView({ top: 900, bottom: 1000 }, 800)).toBe(false);
    expect(isRectInView({ top: -400, bottom: -10 }, 800)).toBe(false);
  });
});
