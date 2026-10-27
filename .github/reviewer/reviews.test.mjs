// Run with: node --test .github/reviewer/*.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasBotReview } from './reviews.mjs'

const marker = '<!-- termul-reviewer:abc123 -->'
const bot = { login: 'github-actions[bot]', type: 'Bot' }
const human = { login: 'someone', type: 'User' }
const review = (user, body) => ({ user, body })
const filler = (n) => Array.from({ length: n }, () => review(human, 'looks good'))

// Serves `reviews` in pages of `perPage`, like the GitHub list endpoint.
const pager = (reviews, perPage = 100) => {
  const requested = []
  const fetchPage = async (page) => {
    requested.push(page)
    return reviews.slice((page - 1) * perPage, page * perPage)
  }
  return { fetchPage, requested }
}

test('ignores the marker in a review from a non-bot user', async () => {
  const { fetchPage } = pager([review(human, `spoof ${marker}`)])
  assert.equal(await hasBotReview(fetchPage, marker), false)
})

test('ignores the marker from a user whose login only looks like the bot', async () => {
  const { fetchPage } = pager([review({ login: 'github-actions[bot]', type: 'User' }, marker)])
  assert.equal(await hasBotReview(fetchPage, marker), false)
})

test('counts the marker in a review from github-actions[bot]', async () => {
  const { fetchPage } = pager([review(bot, `## Thermo review\n\n${marker}`)])
  assert.equal(await hasBotReview(fetchPage, marker), true)
})

test('ignores a bot review for another commit', async () => {
  const { fetchPage } = pager([review(bot, '<!-- termul-reviewer:other -->')])
  assert.equal(await hasBotReview(fetchPage, marker), false)
})

test('finds the marker on page 2', async () => {
  const { fetchPage, requested } = pager([...filler(100), review(bot, marker)])
  assert.equal(await hasBotReview(fetchPage, marker), true)
  assert.deepEqual(requested, [1, 2])
})

test('stops after a short page', async () => {
  const { fetchPage, requested } = pager(filler(100))
  assert.equal(await hasBotReview(fetchPage, marker), false)
  assert.deepEqual(requested, [1, 2])
})
