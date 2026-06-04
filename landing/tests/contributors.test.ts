import { describe, expect, test } from 'bun:test';

import { contributors } from '../src/data/contributors';
import {
  getDisplayContributors,
  isExcludedContributor,
} from '../src/lib/contributors';

describe('contributors data', () => {
  test('includes expected GitHub usernames', () => {
    const usernames = contributors.map((c) => c.username);

    expect(usernames).toContain('gnoviawan');
    expect(usernames).toContain('mannnrachman');
    expect(new Set(usernames).size).toBe(usernames.length);
  });

  test('each contributor has a GitHub avatar URL', () => {
    for (const contributor of contributors) {
      expect(contributor.avatarUrl).toMatch(
        /^https:\/\/avatars\.githubusercontent\.com\/u\/\d+\?v=4$/,
      );
    }
  });
});

describe('contributor exclusions', () => {
  test('excludes Cursor and Claude bot logins', () => {
    expect(isExcludedContributor('cursor')).toBe(true);
    expect(isExcludedContributor('Claude')).toBe(true);
    expect(isExcludedContributor('cursor[bot]')).toBe(true);
    expect(isExcludedContributor('claude[bot]')).toBe(true);
    expect(isExcludedContributor('cursoragent')).toBe(true);
    expect(isExcludedContributor('gnoviawan')).toBe(false);
  });

  test('filters excluded accounts from the display list', () => {
    const display = getDisplayContributors([
      { username: 'gnoviawan', avatarUrl: 'https://example.com/a.png' },
      { username: 'cursor', avatarUrl: 'https://example.com/b.png' },
      { username: 'claude', avatarUrl: 'https://example.com/c.png' },
    ]);

    expect(display).toHaveLength(1);
    expect(display[0]?.username).toBe('gnoviawan');
  });
});
