/* ST-1 in CMP-6 (AD-6, TQ-5): real authorization-code sign-ins through the entra broker.
   Keycloak 26.8.1 imports the committed signin-reports realm and the fake-entra stand-in with the
   env/local.env values, and this suite drives the browser redirects itself: signin-reports →
   fake-entra login form → broker endpoint → BFF callback, then redeems the code as the BFF does.
   Needs a Docker engine; without one the suite fails rather than pretending to pass. */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { keycloakDir, readText } from './load.js'

const image = 'quay.io/keycloak/keycloak:26.8.1'
const container = `kc-signin-it-${process.pid}`

const local = Object.fromEntries(
  readText('env/local.env')
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
) as Record<string, string>
const origin = String(local.KEYCLOAK_PUBLIC_ORIGIN)
const callback = `${local.SR_PUBLIC_ORIGIN}/auth/callback`
const brokerEndpoint = `${origin}/realms/signin-reports/broker/entra/endpoint`

/* Generated per run and handed to Keycloak only through the vault files and the container env. */
const entraClientSecret = randomBytes(24).toString('hex')
const bffClientSecret = randomBytes(24).toString('hex')
const userPassword = randomBytes(18).toString('base64url')

const work = mkdtempSync(join(tmpdir(), 'kc-signin-it-'))
const tls = join(work, 'tls')
const vault = join(work, 'vault')
const realms = join(work, 'realms')
let ca = ''

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8' })
}

/** A world-readable directory: Keycloak runs as UID 1000 inside the container. */
function shared(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o755)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
    chmodSync(join(dir, name), 0o644)
  }
}

/* ---- a minimal browser: one cookie jar per person, redirects followed by hand ---- */

type Response = { status: number; location: string | undefined; body: string; url: string }

class Browser {
  private readonly cookies = new Map<string, { path: string; value: string }>()

  async send(method: 'GET' | 'POST', url: string, form?: Record<string, string>): Promise<Response> {
    const target = new URL(url)
    const body = form ? new URLSearchParams(form).toString() : undefined
    const cookie = [...this.cookies.entries()]
      .filter(([, entry]) => target.pathname.startsWith(entry.path))
      .map(([key, entry]) => `${key.slice(0, key.indexOf('|'))}=${entry.value}`)
      .join('; ')
    const headers: Record<string, string> = {}
    if (cookie) headers.cookie = cookie
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded'
    return new Promise((resolve, reject) => {
      const req = request(target, { method, headers, ca }, (res) => {
        this.store(res.headers['set-cookie'] ?? [])
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: text, url: target.href }),
        )
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  private store(headers: string[]) {
    for (const header of headers) {
      const [pair = '', ...attributes] = header.split(';').map((part) => part.trim())
      const name = pair.slice(0, pair.indexOf('='))
      const value = pair.slice(pair.indexOf('=') + 1)
      const attribute = (key: string) =>
        attributes.find((item) => item.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1)
      const path = attribute('path') ?? '/'
      const expired = attribute('max-age') === '0' || Date.parse(attribute('expires') ?? '') < Date.now()
      if (expired) this.cookies.delete(`${name}|${path}`)
      else this.cookies.set(`${name}|${path}`, { path, value })
    }
  }

  /** Follows redirects until a page is rendered or the browser is sent to one of the stop URLs. */
  async browse(method: 'GET' | 'POST', url: string, form?: Record<string, string>, stopAt = [callback]) {
    let response = await this.send(method, url, form)
    for (let hops = 0; hops < 20; hops++) {
      if (response.status < 300 || response.status >= 400 || !response.location) return { page: response }
      const next = new URL(response.location, response.url).href
      if (stopAt.some((prefix) => next.startsWith(prefix))) return { redirect: new URL(next) }
      response = await this.send('GET', next)
    }
    throw new Error(`too many redirects from ${url}`)
  }
}

type Outcome = Awaited<ReturnType<Browser['browse']>>

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** The authorization request the BFF sends to the signin-reports realm. */
function authorize(extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce()
  const url = new URL(`${origin}/realms/signin-reports/protocol/openid-connect/auth`)
  url.search = new URLSearchParams({
    client_id: 'signin-reports-bff',
    redirect_uri: callback,
    response_type: 'code',
    scope: 'openid',
    state: randomBytes(8).toString('hex'),
    nonce: randomBytes(8).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  }).toString()
  return { url: url.href, verifier }
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#x3D;/gi, '=')
    .replace(/&quot;/g, '"')
}

/** The fake-entra username/password form, if the outcome is that page. */
function fakeEntraLoginForm(outcome: Outcome): string | undefined {
  if (!('page' in outcome) || !outcome.page.url.startsWith(`${origin}/realms/fake-entra/`)) return undefined
  const form = outcome.page.body.match(/<form\b[^>]*\bid="kc-form-login"[^>]*>/)?.[0]
  const action = form?.match(/\baction="([^"]+)"/)?.[1]
  return action ? decodeEntities(action) : undefined
}

async function submitFakeEntra(browser: Browser, outcome: Outcome, username: string): Promise<Outcome> {
  const action = fakeEntraLoginForm(outcome)
  if (!action) throw new Error(`expected the fake-entra login form, got ${JSON.stringify(outcome).slice(0, 400)}`)
  return browser.browse('POST', action, { username, password: userPassword, credentialId: '' })
}

type IdToken = { roles?: string[]; auth_time?: number; tid?: string; preferred_username?: string }

/** Redeems the code at the token endpoint as the confidential BFF client and decodes the ID token. */
async function redeem(browser: Browser, outcome: Outcome, verifier: string): Promise<IdToken> {
  if (!('redirect' in outcome)) throw new Error(`no callback: ${outcome.page.status} at ${outcome.page.url}`)
  const code = outcome.redirect.searchParams.get('code')
  if (!code) throw new Error(`callback without a code: ${outcome.redirect.href}`)
  const token = await browser.send('POST', `${origin}/realms/signin-reports/protocol/openid-connect/token`, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: callback,
    code_verifier: verifier,
    client_id: 'signin-reports-bff',
    client_secret: bffClientSecret,
  })
  expect(token.status, token.body).toBe(200)
  const idToken = String((JSON.parse(token.body) as { id_token?: string }).id_token)
  return JSON.parse(Buffer.from(String(idToken.split('.')[1]), 'base64url').toString('utf8')) as IdToken
}

async function signIn(browser: Browser, username: string, extra: Record<string, string> = {}) {
  const { url, verifier } = authorize(extra)
  const atEntra = await browser.browse('GET', url)
  const back = await submitFakeEntra(browser, atEntra, username)
  return { back, verifier }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeAll(async () => {
  const version = docker(['version', '--format', '{{.Server.Version}}'])
  if (version.status !== 0) {
    throw new Error(`this suite starts ${image} and needs a Docker engine: ${version.stderr || version.error}`)
  }
  const openssl = spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(work, 'key.pem'),
    '-out',
    join(work, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
  ])
  if (openssl.status !== 0) throw new Error(`openssl failed: ${openssl.stderr}`)
  ca = readFileSync(join(work, 'cert.pem'), 'utf8')
  shared(tls, { 'cert.pem': ca, 'key.pem': readFileSync(join(work, 'key.pem'), 'utf8') })
  /* The file vault keys each secret by realm: <realm>_<name>. */
  shared(vault, {
    'signin-reports_entra_client_secret': entraClientSecret,
    'signin-reports_bff_client_secret': bffClientSecret,
  })
  shared(realms, {})
  copyFileSync(join(keycloakDir, 'realms/local/fake-entra-realm.json'), join(realms, 'fake-entra-realm.json'))
  copyFileSync(join(keycloakDir, 'realms/signin-reports-realm.json'), join(realms, 'signin-reports-realm.json'))
  for (const name of ['fake-entra-realm.json', 'signin-reports-realm.json']) chmodSync(join(realms, name), 0o644)

  const port = new URL(origin).port
  const run = docker([
    'run',
    '--detach',
    '--name',
    container,
    '--publish',
    `127.0.0.1:${port}:${port}`,
    '--env-file',
    join(keycloakDir, 'env/local.env'),
    '--env',
    `ENTRA_CLIENT_SECRET=${entraClientSecret}`,
    '--env',
    `FAKE_ENTRA_USER_PASSWORD=${userPassword}`,
    '--volume',
    `${tls}:/opt/keycloak/conf/tls:ro`,
    '--volume',
    `${vault}:/opt/keycloak/vault:ro`,
    '--volume',
    `${realms}:/opt/keycloak/data/import:ro`,
    image,
    'start-dev',
    '--import-realm',
    '--http-enabled=false',
    `--https-port=${port}`,
    '--https-certificate-file=/opt/keycloak/conf/tls/cert.pem',
    '--https-certificate-key-file=/opt/keycloak/conf/tls/key.pem',
    '--truststore-paths=/opt/keycloak/conf/tls/cert.pem',
    '--vault=file',
    '--vault-dir=/opt/keycloak/vault',
  ])
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)

  const ready = `${origin}/realms/signin-reports/.well-known/openid-configuration`
  const deadline = Date.now() + 240_000
  for (;;) {
    const status = await new Browser().send('GET', ready).then(
      (response) => response.status,
      () => 0,
    )
    if (status === 200) break
    if (Date.now() > deadline) {
      throw new Error(`Keycloak did not become ready:\n${docker(['logs', '--tail', '80', container]).stdout}`)
    }
    await sleep(2_000)
  }
}, 300_000)

afterAll(() => {
  docker(['rm', '--force', container])
})

describe('signing in through the entra broker to fake-entra', () => {
  it('AC-2: a reader-group member gets an ID token with roles [reader]', async () => {
    const browser = new Browser()
    const { back, verifier } = await signIn(browser, 'reader')
    const claims = await redeem(browser, back, verifier)
    expect(claims.roles).toEqual(['reader'])
    expect(claims.tid).toBe(local.ENTRA_TENANT_ID)
  }, 60_000)

  it('AC-3: a person with both app roles gets reader and report-admin', async () => {
    const browser = new Browser()
    const { back, verifier } = await signIn(browser, 'reader-admin')
    const claims = await redeem(browser, back, verifier)
    expect([...(claims.roles ?? [])].sort()).toEqual(['reader', 'report-admin'])
  }, 60_000)

  it('AC-7: an administrator without the reader app role gets report-admin only', async () => {
    const browser = new Browser()
    const { back, verifier } = await signIn(browser, 'admin')
    const claims = await redeem(browser, back, verifier)
    expect(claims.roles).toEqual(['report-admin'])
  }, 60_000)

  it('AC-5: an account in neither group signs in with no report role at all', async () => {
    const browser = new Browser()
    const { back, verifier } = await signIn(browser, 'outsider')
    const claims = await redeem(browser, back, verifier)
    expect(claims.roles ?? []).toEqual([])
    expect(claims.preferred_username).toBe('outsider')
  }, 60_000)

  it('an account from another tenant is refused by the tid check: no code reaches the BFF', async () => {
    const browser = new Browser()
    const { back } = await signIn(browser, 'other-tenant')
    if ('redirect' in back) {
      expect(back.redirect.searchParams.get('code')).toBeNull()
      expect(back.redirect.searchParams.get('error')).not.toBeNull()
    } else {
      expect(back.page.url.startsWith(`${origin}/realms/signin-reports/`)).toBe(true)
      expect(back.page.body).not.toMatch(/kc-form-login/)
    }
  }, 60_000)
})

describe('TQ-5: a fresh sign-in makes Entra re-prompt instead of reusing its SSO session', () => {
  it('max_age=900 with prompt=login shows the fake-entra login form again and returns a fresh auth_time', async () => {
    const browser = new Browser()
    const first = await signIn(browser, 'reader')
    const before = await redeem(browser, first.back, first.verifier)
    await sleep(2_000)

    /* Control: fake-entra still holds an SSO session and would hand out a code without a form. */
    const { challenge } = pkce()
    const direct = new URL(String(local.ENTRA_AUTHORIZATION_URL))
    direct.search = new URLSearchParams({
      client_id: String(local.ENTRA_CLIENT_ID),
      redirect_uri: brokerEndpoint,
      response_type: 'code',
      scope: 'openid',
      state: 'control',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    const reused = await browser.browse('GET', direct.href, undefined, [brokerEndpoint])
    expect('redirect' in reused && reused.redirect.searchParams.get('code')).toBeTruthy()

    const { url, verifier } = authorize({ max_age: '900', prompt: 'login' })
    const again = await browser.browse('GET', url)
    expect(fakeEntraLoginForm(again)).toBeDefined()
    const back = await submitFakeEntra(browser, again, 'reader')
    const after = await redeem(browser, back, verifier)
    expect(after.roles).toEqual(['reader'])
    expect(Number(after.auth_time)).toBeGreaterThan(Number(before.auth_time))
    expect(Number(after.auth_time)).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 30)
  }, 90_000)

  it('an auth_time older than max_age makes fake-entra re-prompt (900 s scaled down to 1 s)', async () => {
    const browser = new Browser()
    const first = await signIn(browser, 'reader')
    const before = await redeem(browser, first.back, first.verifier)
    await sleep(2_500)

    const { url, verifier } = authorize({ max_age: '1' })
    const again = await browser.browse('GET', url)
    expect(fakeEntraLoginForm(again)).toBeDefined()
    const after = await redeem(browser, await submitFakeEntra(browser, again, 'reader'), verifier)
    expect(Number(after.auth_time)).toBeGreaterThan(Number(before.auth_time))
  }, 90_000)
})
