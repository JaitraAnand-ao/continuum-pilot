/* The packages/web stylesheet: design tokens only, a visible focus ring, a visually hidden
 * utility for the live regions, reduced motion honoured, and no horizontal scrolling at
 * 320px on any ST-1 screen (WCAG 1.4.10 reflow). */
import { readFileSync } from 'node:fs'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Screen } from '../app/controller'
import { bundle, executablePath, launch, open } from '../test-support/browser'
import { readerAdminMe } from '../test-support/fixtures'

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the stylesheet uses design tokens only', () => {
  const tokens = withoutComments(read('./tokens.css'))
  const app = withoutComments(read('./app.css'))

  it('tokens.css only declares custom properties', () => {
    const declarations = [...tokens.matchAll(/([^{};\s][^{};]*):[^;{}]+;/g)].map((match) => match[1]?.trim())
    expect(declarations.length).toBeGreaterThan(0)
    expect(declarations.filter((name) => !name?.startsWith('--'))).toEqual([])
  })

  it('app.css brings the tokens in and holds no raw colour, length or duration of its own', () => {
    expect(app).toContain("@import './tokens.css';")
    const values = [...app.matchAll(/[{;]\s*([a-z-]+)\s*:\s*([^;{}]+);/g)].map((match) => `${match[1]}: ${match[2]}`)
    expect(values.length).toBeGreaterThan(0)
    const raw = values.filter((value) =>
      /#[0-9a-f]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch)\(|\d+(\.\d+)?(px|rem|em|ms|s|%|vw|vh)\b/i.test(value),
    )
    expect(raw).toEqual([])
    const tokenNames = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]))
    const used = [...app.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1])
    expect(used.filter((name) => !tokenNames.has(name))).toEqual([])
  })

  it('defines sr-only, the focus ring on buttons, links and focusable headings, and a reduced-motion rule', () => {
    expect(app).toMatch(/\.sr-only\s*{[^}]*clip:/)
    expect(app).toMatch(
      /button:focus-visible[\s\S]*?a:focus-visible[\s\S]*?\[tabindex='-1'\]:focus[^{]*{[^}]*var\(--focus-ring-/,
    )
    expect(app).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})

const SCREENS: Array<[string, Screen]> = [
  ['Sign in', { kind: 'sign-in', notice: 'expired' }],
  ['Signing you in', { kind: 'checking' }],
  [
    'No access',
    {
      kind: 'no-access',
      title:
        "You don't have access. Signed in as maximilian.vandenberg-oyelaran@contoso-international.onmicrosoft.com.",
    },
  ],
  [
    "Sign-in didn't complete",
    {
      kind: 'sign-in-error',
      error: {
        code: 'AADSTS50105_ApplicationAssignmentRequired',
        reference: '7f3c9a1e-4b2d-4e8f-9c1a-0d6b5e2f3a7c',
        occurredAt: '2026-10-19T08:12:03.000Z',
      },
    },
  ],
  ['Service unavailable', { kind: 'unavailable' }],
  [
    'the signed-in frame',
    {
      kind: 'app',
      me: { ...readerAdminMe, account: 'maximilian.vandenberg-oyelaran@contoso-international.onmicrosoft.com' },
      route: 'suspicious',
      idleWarning: false,
    },
  ],
  ['the idle warning', { kind: 'app', me: readerAdminMe, route: 'daily', idleWarning: true }],
]

describe.skipIf(!executablePath)('the stylesheet in the browser', { timeout: 60_000 }, () => {
  let browser: Browser
  let built: Awaited<ReturnType<typeof bundle>>

  beforeAll(async () => {
    ;[built, browser] = await Promise.all([bundle(), launch()])
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  async function show(state: Screen, width = 1280): Promise<Page> {
    const page = await open(browser, built, '/', { width })
    await page.evaluate((initial) => {
      window.SignInReports.renderState(document.getElementById('root') as HTMLElement, initial)
    }, state)
    return page
  }

  it('the stylesheet reaches the page', () => {
    expect(built.style).toContain('.sr-only')
    expect(built.style).toContain('--focus-ring-color')
  })

  it.each(SCREENS)('%s does not scroll horizontally at 320px', async (_name, state) => {
    const page = await show(state, 320)
    const widths = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }))
    expect(widths.document).toBeLessThanOrEqual(widths.viewport)
  })

  it('sr-only hides text visually but keeps it in the page', async () => {
    const page = await show({ kind: 'sign-in' })
    const box = await page.evaluate(() => {
      const region = document.createElement('div')
      region.className = 'sr-only'
      region.textContent = 'Signing you in'
      document.body.append(region)
      const { width, height } = region.getBoundingClientRect()
      return { width, height, text: region.textContent, display: getComputedStyle(region).display }
    })
    expect(box).toEqual({ width: 1, height: 1, text: 'Signing you in', display: 'block' })
  })

  it.each([
    ['a button', { kind: 'sign-in' } as Screen, '#sign-in-button', 'Tab'],
    ['a link', SCREENS[5]![1], 'nav a', 'Tab'],
    ['a focusable heading', { kind: 'unavailable' } as Screen, '#unavailable-heading', ''],
  ])('%s shows the focus-ring token when focused', async (_name, state, selector, key) => {
    const page = await show(state)
    const reached = () => page.evaluate((target) => document.activeElement?.matches(target) ?? false, selector)
    if (key) for (let presses = 0; presses < 10 && !(await reached()); presses++) await page.keyboard.press(key)
    else await page.evaluate((target) => (document.querySelector(target) as HTMLElement).focus(), selector)
    expect(await reached()).toBe(true)
    const ring = await page.evaluate((target) => {
      const element = document.querySelector(target) as HTMLElement
      const style = getComputedStyle(element)
      const root = getComputedStyle(document.documentElement)
      const probe = document.createElement('div')
      probe.style.color = root.getPropertyValue('--focus-ring-color')
      document.body.append(probe)
      return {
        style: style.outlineStyle,
        width: style.outlineWidth,
        color: style.outlineColor,
        token: getComputedStyle(probe).color,
      }
    }, selector)
    expect(ring.style).toBe('solid')
    expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2)
    expect(ring.color).toBe(ring.token)
  })

  it('drops transitions when the person asks for reduced motion', async () => {
    const page = await show({ kind: 'sign-in' })
    const duration = () =>
      page.evaluate(() => getComputedStyle(document.getElementById('sign-in-button') as HTMLElement).transitionDuration)
    expect(await duration()).not.toBe('0s')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await duration()).toBe('0s')
  })
})
