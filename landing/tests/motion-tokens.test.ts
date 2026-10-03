import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
