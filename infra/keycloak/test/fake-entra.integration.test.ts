import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readJson, signinRealmPath, type Json } from './load'

/* Integration against a running Keycloak built from this directory, with the signin-reports
 * realm brokering to the fake-entra realm. The sandbox has no container runtime, so this runs
 * only where SR_KEYCLOAK_TEST_URL points at that stack (e.g. `docker compose up keycloak`):
 *
 *   SR_KEYCLOAK_TEST_URL     base URL of Keycloak as the browser sees it
 *   SR_BFF_CLIENT_SECRET     the secret the signin-reports-bff client was imported with
 *   FAKE_ENTRA_USER_PASSWORD the password the fake-entra users were imported with
 *
 * It drives the browser flow with plain fetch: authorize at signin-reports, get redirected to
 * fake-entra, submit its login form, and redeem the code the way the BFF does. */

const base = process.env.SR_KEYCLOAK_TEST_URL?.replace(/\/$/, '')
const realm: Json = readJson(signinRealmPath)
const bff: Json = realm.clients.find((client: Json) => client.clientId === 'signin-reports-bff')
const origin = new URL(base ?? 'https://localhost').origin
const redirectUri = String(bff.redirectUris[0]).replace('${SR_PUBLIC_ORIGIN}', origin)
const oidc = `${base}/realms/${realm.realm}/protocol/openid-connect`

class Browser {
  private readonly cookies = new Map<string, string>()
  /** Every URL the browser was sent to, in order. */
  readonly visited: string[] = []

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    this.visited.push(url)
    const headers = new Headers(init.headers)
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    const response = await fetch(url, { ...init, headers, redirect: 'manual' })
    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1)
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }

  /** Follows redirects until the dashboard callback (returned) or a page that is not a redirect. */
  async follow(url: string, init: RequestInit = {}): Promise<{ callback?: URL; page?: string }> {
    let response = await this.request(url, init)
    for (let hops = 0; hops < 20; hops += 1) {
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location) return { page: await response.text() }
      const next = new URL(location, response.url || url).toString()
      if (next.startsWith(redirectUri)) return { callback: new URL(next) }
      response = await this.request(next)
    }
    throw new Error('redirect loop')
  }
}

const loginForm = (page: string | undefined): string | undefined =>
  page?.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')

async function authorize(browser: Browser, extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const query = new URLSearchParams({
    client_id: bff.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    state: randomBytes(8).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  })
  return { verifier, ...(await browser.follow(`${oidc}/auth?${query}`)) }
}

async function submit(browser: Browser, page: string | undefined, username: string) {
  const action = loginForm(page)
  if (!action) throw new Error('fake-entra login form not shown')
  return browser.follow(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password: process.env.FAKE_ENTRA_USER_PASSWORD ?? '' }),
  })
}

async function redeem(callback: URL | undefined, verifier: string): Promise<Json> {
  const code = callback?.searchParams.get('code')
  if (!code) throw new Error(`no code: ${callback?.search ?? 'no callback'}`)
  const response = await fetch(`${oidc}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: bff.clientId,
      client_secret: process.env.SR_BFF_CLIENT_SECRET ?? '',
    }),
  })
  expect(response.status).toBe(200)
  const { access_token: accessToken } = (await response.json()) as { access_token: string }
  return JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
}

async function signIn(username: string, browser = new Browser()) {
  const start = await authorize(browser)
  const done = await submit(browser, start.page, username)
  return { browser, done, claims: done.callback ? await redeem(done.callback, start.verifier) : undefined }
}

describe.skipIf(!base)('signin-reports brokering to fake-entra', () => {
  it('sends the browser to Entra (fake-entra) with no local login form of its own', async () => {
    const browser = new Browser()
    const start = await authorize(browser)
    expect(browser.visited.some((url) => url.includes('/realms/fake-entra/'))).toBe(true)
    expect(loginForm(start.page)).toContain('/realms/fake-entra/')
  })

  it('maps the reader app role to reader only (AC-2)', async () => {
    const { claims } = await signIn('reader@fake-entra.test')
    expect(claims.roles).toEqual(['reader'])
    expect(typeof claims.auth_time).toBe('number')
  })

  it('maps reader plus administrator to both roles (AC-3)', async () => {
    const { claims } = await signIn('both@fake-entra.test')
    expect([...claims.roles].sort()).toEqual(['reader', 'report-admin'])
  })

  it('gives an administrator without the reader role no reader role (AC-7)', async () => {
    const { claims } = await signIn('admin-only@fake-entra.test')
    expect(claims.roles).toEqual(['report-admin'])
  })

  it('gives an account in neither group no role at all, so the BFF denies it (AC-5)', async () => {
    const { claims } = await signIn('outsider@fake-entra.test')
    expect(claims.roles ?? []).toEqual([])
  })

  it('turns away a reader from a foreign tenant at the tid check: no code is issued', async () => {
    const { done } = await signIn('foreign@other-tenant.test')
    expect(done.callback?.searchParams.get('code') ?? null).toBeNull()
  })

  it('reuses the Entra session when no re-authentication is asked for', async () => {
    const { browser } = await signIn('reader@fake-entra.test')
    const again = await authorize(browser)
    expect(again.callback?.searchParams.get('code')).toBeTruthy()
  })

  it('makes Entra re-prompt when auth_time is older than max_age, instead of reusing its session (TQ-5)', async () => {
    const { browser } = await signIn('reader@fake-entra.test')
    /* The BFF asks max_age=900 for approvals; waiting 15 minutes is the same rule as waiting past 1 s. */
    await new Promise((resolve) => setTimeout(resolve, 2000))
    browser.visited.length = 0
    const step = await authorize(browser, { max_age: '1' })
    const atEntra = browser.visited.find((url) => url.includes('/realms/fake-entra/protocol/openid-connect/auth'))
    expect(new URL(atEntra ?? 'https://missing').searchParams.get('max_age')).toBe('1')
    expect(loginForm(step.page)).toContain('/realms/fake-entra/')
    const done = await submit(browser, step.page, 'reader@fake-entra.test')
    const claims = await redeem(done.callback, step.verifier)
    expect(Date.now() / 1000 - claims.auth_time).toBeLessThan(60)
  })

  it('forwards prompt=login to Entra so it re-prompts as well', async () => {
    const { browser } = await signIn('reader@fake-entra.test')
    browser.visited.length = 0
    const step = await authorize(browser, { prompt: 'login' })
    const atEntra = browser.visited.find((url) => url.includes('/realms/fake-entra/protocol/openid-connect/auth'))
    expect(new URL(atEntra ?? 'https://missing').searchParams.get('prompt')).toBe('login')
    expect(loginForm(step.page)).toContain('/realms/fake-entra/')
  })
})
