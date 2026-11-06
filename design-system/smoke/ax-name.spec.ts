import { expect, test } from 'playwright/test'
import { nameProblems, readAxNodes } from './helpers/ax-name'

// Tailwind's `sr-only`, inlined so this page needs no stylesheet.
const SR_ONLY =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0'

/**
 * Guards the guard: the #1512 markup must still read wrong in Chrome, or the
 * canvas check below would pass for the wrong reason. jsdom names both buttons
 * "Claude Opus, thinking High".
 */
test('the AX read sees the Chrome-only space from an sr-only span', async ({ page }) => {
  await page.setContent(`
    <button aria-pressed="true">Claude Opus<span style="${SR_ONLY}">, thinking High</span></button>
    <button aria-label="Claude Opus, thinking High">Claude Opus</button>
  `)
  const [spanRow, labelRow] = await readAxNodes(page, ['button'])

  expect(spanRow?.name).toBe('Claude Opus , thinking High')
  expect(spanRow?.pressed).toBe(true)
  expect(nameProblems(spanRow?.name ?? '')).toContain('space before comma or period')

  expect(labelRow?.name).toBe('Claude Opus, thinking High')
  expect(nameProblems(labelRow?.name ?? '')).toEqual([])
})

test('nameProblems flags spaces before punctuation and at the edges', () => {
  expect(nameProblems('Move Surface tokens')).toEqual([])
  expect(nameProblems('Surface tokens. Copy name')).toEqual([])
  expect(nameProblems('Opus · Cursor')).toEqual([])
  expect(nameProblems('Opus , High')).toEqual(['space before comma or period'])
  expect(nameProblems('Opus . Copy')).toEqual(['space before comma or period'])
  expect(nameProblems(' Opus')).toEqual(['leading or trailing whitespace'])
})

test('nameProblems flags a stray space before ending punctuation only', () => {
  expect(nameProblems('Opus , High')).toEqual(['space before comma or period'])
  expect(nameProblems('Opus ,High')).toEqual(['space before comma or period'])
  expect(nameProblems('Opus . Copy')).toEqual(['space before comma or period'])
  expect(nameProblems('Name .')).toEqual(['space before comma or period'])
  expect(nameProblems('Open .env')).toEqual([])
  expect(nameProblems('Loading ...')).toEqual([])
  expect(nameProblems('Version 2 .x')).toEqual([])
})
