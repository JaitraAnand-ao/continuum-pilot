/* Test support: builds the SPA with the package's own Vite and drives it in Playwright's
 * Chromium, for what only a real DOM can prove: focus, live regions, modal dialogs and
 * layout at 320px. jsdom is not among the installed dependencies; Chromium is. Tests skip
 * cleanly where no Chromium is installed. */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { build, type Rollup } from 'vite'

/** What browser-entry.tsx puts on the page, for page.evaluate callbacks. */
export type Entry = typeof import('./browser-entry')

declare global {
  interface Window {
    SignInReports: Entry
  }
}

export const ORIGIN = 'http://signin-reports.test'

/** Playwright's own Chromium, or any Chromium build under PLAYWRIGHT_BROWSERS_PATH. */
function chromiumPath(): string | undefined {
  if (existsSync(chromium.executablePath())) return chromium.executablePath()
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root || !existsSync(root)) return undefined
  return readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .flatMap((name) => ['chrome-linux64', 'chrome-linux'].map((dir) => join(root, name, dir, 'chrome')))
    .find((path) => existsSync(path))
}

export const executablePath = chromiumPath()

/** The test entry (and through it the whole SPA and its stylesheet) as one script and one stylesheet. */
export async function bundle(): Promise<{ script: string; style: string }> {
  const output = (await build({
    configFile: false,
    logLevel: 'silent',
    root: new URL('..', import.meta.url).pathname,
    define: { 'process.env.NODE_ENV': '"development"' },
    esbuild: { jsx: 'automatic' },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: new URL('./browser-entry.tsx', import.meta.url).pathname,
        formats: ['iife'],
        name: 'SignInReports',
      },
    },
  })) as Rollup.RollupOutput[]
  const files = output.flatMap((result) => result.output)
  const script = files.find((file): file is Rollup.OutputChunk => file.type === 'chunk')?.code ?? ''
  const style = files
    .filter((file): file is Rollup.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.css'))
    .map((file) => String(file.source))
    .join('\n')
  return { script, style }
}

const PAGE = (style: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Entra Sign-In Reports</title><style>${style}</style><script src="/app.js"></script></head><body><div id="root"></div></body></html>`

export async function launch(): Promise<Browser> {
  return chromium.launch(executablePath ? { executablePath } : {})
}

/** The id of the focused element, or its tag name when it has none (BODY means focus was lost). */
export const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || '')

/** A page at `path` on the test origin serving the bundle; nothing else is reachable.
 * `before` runs ahead of navigation, for init scripts that stub browser APIs. */
export async function open(
  browser: Browser,
  { script, style }: { script: string; style: string },
  path: string,
  { width = 1280, before }: { width?: number; before?: (page: Page) => Promise<unknown> } = {},
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) return route.abort()
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script })
    return route.fulfill({ contentType: 'text/html', body: PAGE(style) })
  })
  if (before) await before(page)
  await page.goto(`${ORIGIN}${path}`)
  return page
}
