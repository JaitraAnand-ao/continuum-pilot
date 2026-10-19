/* Mounts the SPA through mount() in real Playwright chromium (no jsdom) and asserts
 * document.activeElement and the live regions for every focus trigger in ST-1. */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { copy } from './copy'
import { SIGNED_IN_AT, noAccessProblem, readerMe, unauthenticatedProblem } from './test-support/fixtures'

const ORIGIN = 'http://dashboard.test'
const HTML =
  '<!doctype html><html lang="en"><head><title>…</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'

interface Reply {
  status: number
  body: unknown
  type?: string
}

/* The sandbox may preinstall a chromium build other than the one this Playwright release names. */
function chromiumExecutable(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? ''
  const builds = existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('chromium_headless_shell-')) : []
  return builds
    .sort()
    .reverse()
    .flatMap((name) => [
      join(root, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      join(root, name, 'chrome-linux', 'headless_shell'),
    ])
    .find((path) => existsSync(path))
}

let browser: Browser
let bundle: string
let page: Page
let meReplies: Reply[]
let logouts: number

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: "import { mount } from './mount'\nvoid mount(document.getElementById('root'))",
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  })
  bundle = result.outputFiles[0]?.text ?? ''
  const executablePath = chromiumExecutable()
  browser = await chromium.launch(executablePath ? { executablePath } : {})
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

afterEach(async () => {
  await page?.close()
})

async function open(path: string, replies: Reply[]): Promise<void> {
  meReplies = replies
  logouts = 0
  page = await browser.newPage()
  await page.clock.install({ time: SIGNED_IN_AT + 60_000 })
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (url.pathname === '/api/v1/me') {
      const reply = meReplies.length > 1 ? meReplies.shift()! : meReplies[0]!
      return route.fulfill({
        status: reply.status,
        contentType: reply.type ?? 'application/json',
        body: JSON.stringify(reply.body),
      })
    }
    if (url.pathname === '/auth/logout') {
      logouts++
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ contentType: 'text/html', body: HTML })
  })
  await page.goto(`${ORIGIN}${path}`)
}

/* The focused element, named by its id or else its text. */
const active = (): Promise<string> =>
  page.evaluate(() => {
    const element = document.activeElement
    return element?.id || element?.textContent?.trim() || element?.tagName || ''
  })

/* Lets fetches settle and the faked clock run the animation frame that moves focus. */
async function focusSettlesOn(expected: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.clock.runFor(20)
        return active()
      },
      { timeout: 5_000, interval: 25 },
    )
    .toBe(expected)
}

const liveText = (testId: string): Promise<string> =>
  page.locator(`[data-testid="${testId}"]`).evaluate((element) => element.textContent ?? '')

const problem = (body: unknown): Reply => ({ status: 403, body, type: 'application/problem+json' })
const me = (body: unknown): Reply => ({ status: 200, body })

describe('focus follows every ST-1 trigger in a real DOM', { timeout: 30_000 }, () => {
  it("@AC-1 on load without a session, focus is on 'Sign in with Microsoft'", async () => {
    await open('/', [{ status: 401, body: unauthenticatedProblem, type: 'application/problem+json' }])
    await focusSettlesOn('signin-button')
    expect(await page.locator('#signin-button').textContent()).toBe(copy.signIn.button)
  })

  it('@AC-2 landing on the Daily report puts focus on its heading', async () => {
    await open('/signing-in', [me(readerMe)])
    await focusSettlesOn('page-heading')
    expect(await page.locator('#page-heading').textContent()).toBe(copy.shell.dailyReport)
    expect(new URL(page.url()).pathname).toBe('/reports/daily')
  })

  it('@AC-5 a denied account lands with focus on the heading and the denial announced assertively', async () => {
    await open('/signing-in', [problem(noAccessProblem)])
    await focusSettlesOn('page-heading')
    expect(await liveText('live-assertive')).toBe(noAccessProblem.title)
    expect(await page.title()).toBe('No access – Entra Sign-In Reports')
  })

  it('@AC-6 a failed sign-in lands with focus on the heading', async () => {
    await open('/signin-error?error=AADSTS50105&ref=c0ffee&at=2026-10-19T08%3A00%3A05Z', [me(readerMe)])
    await focusSettlesOn('page-heading')
    expect(await liveText('live-assertive')).toBe(copy.failed.heading)
  })

  it("@AC-9 the idle warning takes focus on 'Stay signed in' and is announced once, assertively", async () => {
    await open('/signing-in', [me(readerMe)])
    await focusSettlesOn('page-heading')
    await page.clock.fastForward('12:00')
    await focusSettlesOn('stay-signed-in')
    expect(await liveText('live-assertive')).toBe(copy.idle.announcement)
    expect(await liveText('live-polite')).not.toContain(copy.idle.heading)
    const dialog = page.getByRole('dialog')
    expect(await dialog.getAttribute('aria-labelledby')).toBe('idle-warning-heading')
    expect(await dialog.getAttribute('aria-describedby')).toBeNull()
  })

  it("@AC-9 after 'Stay signed in', focus returns to where it was", async () => {
    const refreshed = { ...readerMe, idleExpiresAt: new Date(SIGNED_IN_AT + 28 * 60_000).toISOString() }
    await open('/signing-in', [me(readerMe), me(refreshed)])
    await focusSettlesOn('page-heading')
    await page.getByRole('link', { name: copy.shell.suspiciousActivity }).focus()
    await page.clock.fastForward('12:00')
    await focusSettlesOn('stay-signed-in')
    await page.keyboard.press('Enter')
    await focusSettlesOn(copy.shell.suspiciousActivity)
    expect(await page.getByRole('dialog').count()).toBe(0)
  })

  it("@AC-9 signing out from the account menu returns focus to 'Sign in with Microsoft'", async () => {
    await open('/signing-in', [me(readerMe)])
    await focusSettlesOn('page-heading')
    await page.getByRole('button', { name: `${copy.shell.accountMenu}, ${readerMe.account}` }).click()
    await page.getByRole('button', { name: copy.shell.signOut }).click()
    await focusSettlesOn('signin-button')
    expect(logouts).toBe(1)
    expect(await liveText('live-polite')).toBe(copy.signIn.signedOut)
  })

  it('Escape closes the account menu and returns focus to its trigger', async () => {
    await open('/signing-in', [me(readerMe)])
    await focusSettlesOn('page-heading')
    const trigger = page.getByRole('button', { name: `${copy.shell.accountMenu}, ${readerMe.account}` })
    await trigger.click()
    await page.keyboard.press('Tab')
    await focusSettlesOn(copy.shell.signOut)
    await page.keyboard.press('Escape')
    await focusSettlesOn(readerMe.account)
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    expect(await page.locator('#account-menu-panel').isHidden()).toBe(true)
  })

  it('Escape on the open trigger itself closes the account menu and keeps focus there', async () => {
    await open('/signing-in', [me(readerMe)])
    await focusSettlesOn('page-heading')
    const trigger = page.getByRole('button', { name: `${copy.shell.accountMenu}, ${readerMe.account}` })
    await trigger.click()
    await page.keyboard.press('Escape')
    await focusSettlesOn(readerMe.account)
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
