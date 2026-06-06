import { contributors as allContributors, type Contributor } from '../data/contributors';

/** GitHub logins excluded from the public contributors grid (AI / bot accounts). */
export const EXCLUDED_CONTRIBUTOR_LOGINS = [
  'cursor',
  'claude',
  'cursoragent',
  'cursor[bot]',
  'claude[bot]',
] as const;

export function isExcludedContributor(username: string): boolean {
  const login = username.toLowerCase();

  if (
    EXCLUDED_CONTRIBUTOR_LOGINS.some((excluded) => login === excluded)
  ) {
    return true;
  }

  return /^cursor(\[bot\]|agent)?$/i.test(username) || /^claude(\[bot\])?$/i.test(username);
}

export function getDisplayContributors(
  source: Contributor[] = allContributors,
): Contributor[] {
  return source.filter((contributor) => !isExcludedContributor(contributor.username));
}
