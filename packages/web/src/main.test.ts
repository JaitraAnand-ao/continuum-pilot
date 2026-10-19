/* mount() wired to a real document: for every trigger in ST-1, where focus lands and what
 * the polite and assertive live regions say. fetch and requestAnimationFrame are stubbed in
 * the page, so the server's answers are fixed and focus moves only when a frame is run. */
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundle, executablePath, focused, launch, open } from './test-support/browser'
import { noAccessProblem, noSessionProblem, readerMe } from './test-support/fixtures'

/** One stubbed answer; `idleInMs` makes a 200 /api/v1/me whose idle limit is that far from now. */
type Answer = { status: number; body?: unknown; idleInMs?: number }

/** Runs in the page before the app: stubs fetch from the queue (an empty queue never answers)
 * and queues animation frames until the test runs them. */
function stubBrowser({ answers, me }: { answers: Answer[]; me: unknown }) {
  const requests: string[] = []
  const frames: FrameRequestCallback[] = []
  window.fetch = async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`)
    const answer = answers.shift()
    if (!answer) return new Promise<Response>(() => undefined)
    let body = answer.body
    if (answer.idleInMs !== undefined) {
      const now = Date.now()
      body = {
        ...(me as object),
        authTime: new Date(now).toISOString(),
        idleExpiresAt: new Date(now + answer.idleInMs).toISOString(),
        absoluteExpiresAt: new Date(now + 8 * 3_600_000).toISOString(),
      }
    }
    const type = answer.status === 200 ? 'application/json' : 'application/problem+json'
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: answer.status,
      headers: { 'content-type': type },
    })
  }
  window.requestAnimationFrame = (callback) => frames.push(callback)
  Object.assign(window, {
    requests,
    runFrames: () => frames.splice(0).forEach((callback) => callback(performance.now())),
  })
}

const minute = 60_000

describe.skipIf(!executablePath)('mount() in the browser', { timeout: 60_000 }, () => {
  let browser: Browser
  let built: Awaited<ReturnType<typeof bundle>>

  beforeAll(async () => {
    ;[built, browser] = await Promise.all([bundle(), launch()])
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  async function start(path: string, ...answers: Answer[]): Promise<Page> {
    const page = await open(browser, built, path, {
      before: (target) => target.addInitScript(stubBrowser, { answers, me: readerMe }),
    })
    await page.evaluate(() => {
      const unmount = window.SignInReports.mount(document.getElementById('root') as HTMLElement)
      Object.assign(window, { unmount })
    })
    return page
  }

  /** Waits for `selector`, then runs the queued frames so the controller's focus moves land. */
  async function settle(page: Page, selector: string) {
    await page.waitForSelector(selector, { state: 'attached' })
    await page.evaluate(() => (window as unknown as { runFrames(): void }).runFrames())
  }

  const regions = (page: Page) =>
    page.evaluate(() => ({
      polite: document.querySelector('[aria-live="polite"]')?.textContent,
      assertive: document.querySelector('[aria-live="assertive"]')?.textContent,
    }))
  const requests = (page: Page) => page.evaluate(() => (window as unknown as { requests: string[] }).requests)

  it('AC-1: a visitor with no session lands on Sign in, focused, and hears nothing about signing in', async () => {
    const page = await start('/', { status: 401, body: noSessionProblem })
    await settle(page, '#sign-in-button')
    expect(await focused(page)).toBe('sign-in-button')
    expect(await regions(page)).toEqual({ polite: '', assertive: '' })
    expect(await page.title()).toBe('Sign in – Entra Sign-In Reports')
    expect(await page.locator('#signing-in-heading').count()).toBe(0)
  })

  it('AC-4: back from Microsoft, the access check is shown, focused and announced politely', async () => {
    const page = await start('/reports/daily?from=microsoft')
    await settle(page, '#signing-in-heading')
    expect(await focused(page)).toBe('signing-in-heading')
    expect(await page.locator('main > *').allInnerTexts()).toEqual([
      'Signing you in…',
      'Checking your access with Microsoft Entra ID.',
    ])
    expect(await regions(page)).toEqual({ polite: 'Signing you in', assertive: '' })
    expect(await page.evaluate(() => location.pathname + location.search)).toBe('/reports/daily')
  })

  it('AC-2: a reader back from Microsoft lands on the Daily report with focus on its heading', async () => {
    const page = await start('/reports/daily?from=microsoft', { status: 200, idleInMs: 15 * minute })
    await settle(page, 'nav')
    expect(await focused(page)).toBe('main-heading')
    expect(await page.locator('#main-heading').innerText()).toBe('Daily report')
    expect(await page.locator('nav a').allInnerTexts()).toEqual([
      'Daily report',
      'Suspicious activity',
      'Report history',
    ])
    expect(await regions(page)).toEqual({ polite: 'Signing you in', assertive: '' })
    expect(await page.title()).toBe('Daily report – Entra Sign-In Reports')
  })

  it('AC-5: an account in neither group is turned away, focused, with the account named assertively', async () => {
    const page = await start('/reports/daily?from=microsoft', { status: 403, body: noAccessProblem })
    await settle(page, '#no-access-heading')
    expect(await focused(page)).toBe('no-access-heading')
    expect(await regions(page)).toEqual({ polite: '', assertive: noAccessProblem.title })
    expect(await page.title()).toBe('No access – Entra Sign-In Reports')
  })

  it("AC-6: a failed Microsoft sign-in shows 'Sign-in didn't complete', focused and announced assertively", async () => {
    const page = await start('/signin?error=AADSTS50105&ref=7f3c9a1e&at=2026-10-19T08:12:03Z')
    await settle(page, '#sign-in-error-heading')
    expect(await focused(page)).toBe('sign-in-error-heading')
    expect(await regions(page)).toEqual({ polite: '', assertive: "Sign-in didn't complete" })
    expect(await requests(page)).toEqual([])
  })

  it('AC-9: the idle warning focuses Stay signed in and is spoken once, by the assertive region', async () => {
    const page = await start('/reports/daily', { status: 200, idleInMs: 2 * minute })
    await settle(page, 'dialog[open]')
    expect(await focused(page)).toBe('stay-signed-in')
    const until = await page.evaluate(() => document.querySelector('#idle-warning-title + p')?.textContent)
    expect(await regions(page)).toEqual({ polite: '', assertive: `Your session is about to end. ${until}` })
    expect(until).toMatch(/^You will be signed out at \d\d:\d\d UTC unless you stay signed in\.$/)
    /* Nothing else speaks it: the dialog is a plain dialog, not an alertdialog, and only
     * its title names it on focus. */
    expect(
      await page.evaluate(() => ({
        alertdialogs: document.querySelectorAll('[role="alertdialog"]').length,
        describedBy: document.querySelector('dialog')?.getAttribute('aria-describedby'),
        liveRegions: document.querySelectorAll('[aria-live], [role="alert"], [role="status"]').length,
      })),
    ).toEqual({ alertdialogs: 0, describedBy: null, liveRegions: 2 })
  })

  it('AC-9: Sign out from the account menu returns to Sign in, focused, said politely', async () => {
    const page = await start('/reports/daily', { status: 200, idleInMs: 15 * minute }, { status: 204 })
    await settle(page, 'nav')
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await settle(page, '#sign-in-button')
    expect(await focused(page)).toBe('sign-in-button')
    expect(await regions(page)).toEqual({ polite: 'You have been signed out.', assertive: '' })
    expect(await page.evaluate(() => location.pathname)).toBe('/signin')
    expect(await requests(page)).toEqual(['GET /api/v1/me', 'POST /auth/logout'])
  })

  it('unmounting removes the app', async () => {
    const page = await start('/', { status: 401, body: noSessionProblem })
    await settle(page, '#sign-in-button')
    await page.evaluate(() => (window as unknown as { unmount(): void }).unmount())
    expect(await page.locator('#root').innerHTML()).toBe('')
  })
})
