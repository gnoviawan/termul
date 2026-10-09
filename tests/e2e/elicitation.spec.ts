import { expect, type Page, test } from 'playwright/test'
import { chatTab, launchChat, openWorkspace, selectProject } from './ui'

/**
 * Elicitation E2E (GH-935): a Devin-style `ask_user_question` batch arrives
 * mid-turn as a standard ACP `elicitation/create` request — the styled
 * multi-question panel must render (header chips carry the schema titles,
 * never the raw `qN` property names), and the submitted answers must
 * round-trip back to the agent as the elicitation response `content`.
 *
 * The fake agent (fake-longrun-agent.ts) sends `elicitation/create` when the
 * prompt carries the `[ELICIT]` marker, holds the turn open until the client
 * responds, then echoes the verbatim wire result into the transcript as
 * `ELICIT_ANSWER=<json>` — the assertions below PARSE that echo instead of
 * string-matching content key order.
 *
 * Chats live in proj-c: proj-x is the crash suite's (its agent dies
 * mid-turn), proj-w is the worktree suite's git repo, and proj-e must stay
 * chat-free for the editor suite's workspace-restore invariants. proj-c is
 * the least contested of the remaining seeded projects — fresh chats are
 * isolated by chat, not project, and every assertion below is scoped to the
 * pane owning this test's chat tab plus the chat's VISIBLE transcript log.
 */

test.setTimeout(120_000)

const TITLE_A = 'color survey'
const TITLE_B = 'shade survey'

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
  await selectProject(page, 'proj-c')
})

/**
 * The workspace pane (`data-pane-content`) that owns this test's chat tab.
 * Every pane keeps all its tab panels mounted (inactive ones hidden), so
 * panel-level assertions must scope to the pane whose tab strip contains
 * the chat under test — see crash-recovery.spec.ts for the same idiom.
 */
function chatPane(page: Page, titlePrefix: string) {
  return page.locator('[data-pane-content]').filter({ has: chatTab(page, titlePrefix) })
}

/**
 * The chat's VISIBLE transcript log (message-scroller's `role="log"`).
 * Other chats in the same pane stay mounted but hidden — `:visible` keeps
 * their transcripts out of the assertion, so accumulated chats from other
 * suites/tests can never satisfy these locators.
 */
function transcript(page: Page, titlePrefix: string) {
  return chatPane(page, titlePrefix).locator('div[role="log"]:visible').first()
}

interface ElicitEcho {
  action?: string
  content?: Record<string, unknown>
  error?: unknown
  /** Present when the echoed payload was not valid JSON. */
  raw?: string
}

/**
 * Parse the fake's `ELICIT_ANSWER=<json>` transcript echo. Returns
 * undefined until the line exists, so callers can `expect.poll` it; a
 * malformed echo comes back as `{ raw }`, which fails the action assertion
 * while keeping the wire text visible in the failure output.
 */
async function readElicitAnswer(page: Page, titlePrefix: string): Promise<ElicitEcho | undefined> {
  const text = await transcript(page, titlePrefix)
    .innerText()
    .catch(() => '')
  const match = /ELICIT_ANSWER=(\{[^\n]+\})/.exec(text)
  if (!match) return undefined
  try {
    return JSON.parse(match[1]) as ElicitEcho
  } catch {
    return { raw: match[1] }
  }
}

/**
 * Wait for the chat's elicitation answer echo and return the parsed
 * response — polls on `action` so an absent/pending echo retries instead
 * of racing the agent→client→agent round trip. An error or unparseable
 * echo fails fast instead of burning the full poll timeout.
 */
async function awaitElicitAnswer(page: Page, titlePrefix: string): Promise<ElicitEcho> {
  let answer: ElicitEcho | undefined
  await expect
    .poll(
      async () => {
        answer = await readElicitAnswer(page, titlePrefix)
        if (!answer) return undefined
        if (answer.error !== undefined || answer.raw !== undefined) {
          throw new Error(`elicitation answered with ${JSON.stringify(answer)}`)
        }
        return answer.action
      },
      { timeout: 30_000 }
    )
    .toBe('accept')
  if (!answer) throw new Error('elicitation echo never arrived')
  return answer
}

test('styled multi-question panel renders and the submitted answers round-trip to the agent', async ({
  page
}) => {
  await launchChat(page, `${TITLE_A} [ELICIT]`)

  const pane = chatPane(page, TITLE_A)
  const questions = pane.getByTestId('elicitation-questions')
  await expect(questions).toBeVisible({ timeout: 30_000 })

  // Two question cards — one per schema property.
  const q0 = pane.getByTestId('elicitation-question-q0')
  const q1 = pane.getByTestId('elicitation-question-q1')
  await expect(q0).toBeVisible()
  await expect(q1).toBeVisible()

  // Header chips carry the schema `title`s and the question text the
  // `description`s — the raw `qN` property names never render as labels
  // (the pre-fix bug this suite guards).
  await expect(q0).toContainText('Color')
  await expect(q0).toContainText('Which color should I use?')
  await expect(q1).toContainText('Features')
  await expect(q1).toContainText('Which features should I enable?')
  await expect(questions).not.toContainText('q0')
  await expect(questions).not.toContainText('q1')

  // q0 single-select option card.
  await q0.getByRole('button', { name: /Red/ }).click()
  // q1 multi-select toggles.
  await q1.getByRole('button', { name: /Logging/ }).click()
  await q1.getByRole('button', { name: /Tracing/ }).click()
  // `_meta["cognition.ai/allowOther"]` → the per-question "Other" affordance;
  // its free text submits as a non-option value appended to the array.
  await pane.getByTestId('elicitation-other-toggle-q1').click()
  await pane.getByTestId('elicitation-other-q1').fill('My custom feature')

  await pane.getByRole('button', { name: 'Send answers' }).click()

  // The agent echoes the verbatim wire response — assert the accept action
  // and the answer content (membership, not ordering).
  const answer = await awaitElicitAnswer(page, TITLE_A)
  expect(answer.content?.q0).toBe('Red')
  expect(answer.content?.q1).toEqual(
    expect.arrayContaining(['Logging', 'Tracing', 'My custom feature'])
  )
  expect(answer.content?.q1).toHaveLength(3)
})

test('unanswered required questions submit as skipped (Send stays enabled)', async ({ page }) => {
  await launchChat(page, `${TITLE_B} [ELICIT]`)

  const pane = chatPane(page, TITLE_B)
  const questions = pane.getByTestId('elicitation-questions')
  await expect(questions).toBeVisible({ timeout: 30_000 })

  const send = pane.getByRole('button', { name: 'Send answers' })
  // Required-but-unanswered questions never block submit — the agent reads
  // an omitted `content` key as a skipped question, not an error.
  await expect(send).toBeEnabled()

  await pane.getByTestId('elicitation-question-q0').getByRole('button', { name: /Blue/ }).click()
  await expect(send).toBeEnabled()
  await send.click()

  const answer = await awaitElicitAnswer(page, TITLE_B)
  expect(answer.content?.q0).toBe('Blue')
  expect(answer.content).toBeDefined()
  expect(answer.content).not.toHaveProperty('q1')
})
