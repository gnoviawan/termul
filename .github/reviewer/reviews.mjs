// The reviews this workflow posts come from the Actions token's bot user.
const BOT_LOGIN = 'github-actions[bot]'
export const REVIEWS_PER_PAGE = 100

// True when github-actions[bot] already posted a review whose body carries
// `marker`. Reviews from anyone else are ignored, so a user cannot paste the
// marker to suppress a review. `fetchPage(page)` returns one page (1-based) of
// the PR's reviews. Pages are read until one comes back short.
export async function hasBotReview(fetchPage, marker) {
  for (let page = 1; ; page++) {
    const reviews = await fetchPage(page)
    const found = reviews.some(
      (r) =>
        r.user?.login === BOT_LOGIN &&
        r.user?.type === 'Bot' &&
        typeof r.body === 'string' &&
        r.body.includes(marker)
    )
    if (found) return true
    if (reviews.length < REVIEWS_PER_PAGE) return false
  }
}
