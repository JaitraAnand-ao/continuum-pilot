/* The interactive widgets in a real browser: the AC-9 idle warning dialog and the account
 * menu. Focus containment, initial focus and focus restoration need a DOM to be proven. */
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Screen } from '../app/controller'
import { bundle, executablePath, focused, launch, open } from '../test-support/browser'
import { readerMe } from '../test-support/fixtures'

const signedIn = (idleWarning: boolean): Screen => ({ kind: 'app', me: readerMe, route: 'daily', idleWarning })

describe.skipIf(!executablePath)('widgets in the browser', { timeout: 60_000 }, () => {
  let browser: Browser
  let built: Awaited<ReturnType<typeof bundle>>

  beforeAll(async () => {
    ;[built, browser] = await Promise.all([bundle(), launch()])
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  /** A page showing `state` through AppView, recording the actions taken. */
  async function show(state: Screen) {
    const page = await open(browser, built, '/reports/daily')
    await page.evaluate((initial) => {
      const view = window.SignInReports.renderState(document.getElementById('root') as HTMLElement, initial)
      Object.assign(window, { view })
    }, state)
    return page
  }
  const rerender = (page: Page, state: Screen) =>
    page.evaluate((next) => (window as unknown as { view: { rerender(s: Screen): void } }).view.rerender(next), state)
  const calls = (page: Page) => page.evaluate(() => (window as unknown as { view: { calls: string[] } }).view.calls)

  describe('the idle warning dialog (AC-9)', () => {
    it("opens as a modal dialog with focus on 'Stay signed in'", async () => {
      const page = await show(signedIn(true))
      expect(await focused(page)).toBe('stay-signed-in')
      expect(
        await page.evaluate(() => {
          const dialog = document.querySelector('dialog')
          return { open: dialog?.open, modal: dialog?.matches(':modal'), role: dialog?.getAttribute('role') }
        }),
      ).toEqual({ open: true, modal: true, role: null })
      const name = await page.getByRole('dialog', { name: 'Your session is about to end' }).count()
      expect(name).toBe(1)
    })

    it('keeps focus inside the dialog when tabbing forwards and backwards past either end', async () => {
      const page = await show(signedIn(true))
      const seen: string[] = []
      for (let step = 0; step < 4; step++) {
        await page.keyboard.press('Tab')
        seen.push(await focused(page))
      }
      for (let step = 0; step < 4; step++) {
        await page.keyboard.press('Shift+Tab')
        seen.push(await focused(page))
      }
      expect(seen).toEqual([
        'idle-sign-out',
        'stay-signed-in',
        'idle-sign-out',
        'stay-signed-in',
        'idle-sign-out',
        'stay-signed-in',
        'idle-sign-out',
        'stay-signed-in',
      ])
    })

    it('leaves the page behind it out of reach', async () => {
      const page = await show(signedIn(true))
      const reachable = await page.evaluate(() => {
        const link = document.querySelector('nav a') as HTMLElement
        link.focus()
        return document.activeElement === link
      })
      expect(reachable).toBe(false)
    })

    it("'Stay signed in' and 'Sign out' do what they say; Escape keeps me signed in", async () => {
      const page = await show(signedIn(true))
      await page.keyboard.press('Enter')
      await page.keyboard.press('Escape')
      expect(await page.evaluate(() => document.querySelector('dialog')?.open)).toBe(true)
      await page.getByRole('button', { name: 'Sign out' }).click()
      expect(await calls(page)).toEqual(['staySignedIn', 'staySignedIn', 'signOut'])
    })

    it('gives focus back to where it was when it closes', async () => {
      const page = await show(signedIn(false))
      await page.evaluate(() => (document.getElementById('main-heading') as HTMLElement).focus())
      await rerender(page, signedIn(true))
      expect(await focused(page)).toBe('stay-signed-in')
      await rerender(page, signedIn(false))
      expect(await focused(page)).toBe('main-heading')
    })
  })

  describe('the account menu (AC-9 Sign out)', () => {
    it('opens from its button with focus on Sign out, and Escape closes it back onto the button', async () => {
      const page = await show(signedIn(false))
      const button = page.getByRole('button', { name: 'Account menu' })
      expect(await button.getAttribute('aria-expanded')).toBe('false')
      await button.click()
      expect(await button.getAttribute('aria-expanded')).toBe('true')
      expect(await focused(page)).toBe('account-sign-out')
      expect(await page.getByText('m.duarte@contoso.com').isVisible()).toBe(true)
      await page.keyboard.press('Escape')
      expect(await button.getAttribute('aria-expanded')).toBe('false')
      expect(await page.getByText('m.duarte@contoso.com').isVisible()).toBe(false)
      expect(await focused(page)).toBe('account-menu-button')
    })

    it('opens from the keyboard and signs out', async () => {
      const page = await show(signedIn(false))
      await page.getByRole('button', { name: 'Account menu' }).focus()
      await page.keyboard.press('Enter')
      expect(await focused(page)).toBe('account-sign-out')
      await page.keyboard.press('Enter')
      expect(await calls(page)).toEqual(['signOut'])
    })
  })
})
