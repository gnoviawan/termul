import { describe, expect, test } from 'bun:test';

import { contributors } from '../src/data/contributors';

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
