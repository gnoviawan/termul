import type {
  GithubComment,
  GithubItemDetail,
  GithubItemKind,
  GithubRepoRef
} from '@shared/types/github.types'

/** The repository as `gh --repo` takes it: `OWNER/REPO`, or `HOST/OWNER/REPO` off github.com. */
export function ghRepoArg(repo: GithubRepoRef): string {
  const slug = `${repo.owner}/${repo.name}`
  return repo.host === 'github.com' ? slug : `${repo.host}/${slug}`
}

/** `acme/app#12`: Termul-built, so it may appear in trusted instructions. */
export function itemReference(repo: GithubRepoRef, number: number): string {
  return `${repo.owner}/${repo.name}#${number}`
}

export function kindNoun(kind: GithubItemKind): string {
  return kind === 'pr' ? 'pull request' : 'issue'
}

/** Title, URL, state, labels and body of an item, as untrusted data lines. */
export function itemSummaryData(detail: GithubItemDetail): string {
  const { item } = detail
  const lines = [
    `Title: ${item.title}`,
    `URL: ${item.url}`,
    `State: ${item.state}`,
    `Author: ${item.author}`
  ]
  if (item.labels.length > 0) lines.push(`Labels: ${item.labels.map((l) => l.name).join(', ')}`)
  lines.push('', 'Body:', detail.body.trim() || '(no description)')
  return lines.join('\n')
}

export function commentData(comment: GithubComment): string {
  return `${comment.author} (${comment.createdAt}):\n${comment.body.trim() || '(no content)'}`
}
