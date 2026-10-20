import { describe, expect, it } from 'vitest'
import { isPlaceholder, placeholders, readJson, readText, signinRealmPath, walk, type Json } from './load'

/* AD-6: the signin-reports realm is code. These tests read the committed export the image
 * imports and hold it to every AD-6 setting: Entra as the only way in, FORCE sync, the tid
 * check, max_age/prompt forwarded to Entra (TQ-5), the AC-9 session limits, and no secrets. */

const realm: Json = readJson(signinRealmPath)
const raw = readText(signinRealmPath)

const flow = (alias: string): Json => realm.authenticationFlows.find((candidate: Json) => candidate.alias === alias)
const entra: Json = realm.identityProviders?.[0]
const bff: Json = realm.clients?.find((client: Json) => client.clientId === 'signin-reports-bff')
const mappers: Json[] = realm.identityProviderMappers ?? []

describe('signin-reports realm export', () => {
  it('is the enabled signin-reports realm and demands TLS on every request', () => {
    expect(realm.realm).toBe('signin-reports')
    expect(realm.enabled).toBe(true)
    expect(realm.sslRequired).toBe('all')
  })

  describe('Entra ID is the only way in (AC-1, AC-5)', () => {
    it('has exactly one identity provider: Entra over OIDC', () => {
      expect(realm.identityProviders).toHaveLength(1)
      expect(entra).toMatchObject({ alias: 'entra', providerId: 'oidc', enabled: true, linkOnly: false })
    })

    it('binds the browser flow to the session cookie and a redirect straight to Entra, with no login form', () => {
      const browser = flow(realm.browserFlow)
      expect(browser.topLevel).toBe(true)
      const steps = browser.authenticationExecutions.map((execution: Json) => [
        execution.authenticator,
        execution.requirement,
      ])
      expect(steps).toEqual([
        ['auth-cookie', 'ALTERNATIVE'],
        ['identity-provider-redirector', 'ALTERNATIVE'],
      ])
      const redirector = browser.authenticationExecutions[1]
      const config = realm.authenticatorConfig.find(
        (candidate: Json) => candidate.alias === redirector.authenticatorConfig,
      )
      expect(config.config.defaultProvider).toBe('entra')
    })

    it('contains no username, password or OTP form in any flow', () => {
      const authenticators = realm.authenticationFlows.flatMap((candidate: Json) =>
        candidate.authenticationExecutions.map((execution: Json) => execution.authenticator ?? ''),
      )
      for (const authenticator of authenticators) {
        expect(authenticator).not.toMatch(/username|password|otp|webauthn|kerberos|x509|registration|reset/)
      }
    })

    it('denies direct grant, registration, credential reset and docker login outright', () => {
      for (const binding of [
        'directGrantFlow',
        'registrationFlow',
        'resetCredentialsFlow',
        'dockerAuthenticationFlow',
      ]) {
        const bound = flow(realm[binding])
        expect(bound, binding).toBeDefined()
        expect(bound.authenticationExecutions).toEqual([
          expect.objectContaining({ authenticator: 'deny-access-authenticator', requirement: 'REQUIRED' }),
        ])
      }
      expect(realm.registrationAllowed).toBe(false)
      expect(realm.resetPasswordAllowed).toBe(false)
      expect(realm.rememberMe).toBe(false)
      expect(realm.loginWithEmailAllowed).toBe(false)
    })

    it('keeps a client-authentication flow so the BFF can redeem codes', () => {
      const clients = flow(realm.clientAuthenticationFlow)
      expect(clients.providerId).toBe('client-flow')
      expect(clients.authenticationExecutions.map((execution: Json) => execution.authenticator)).toContain(
        'client-secret',
      )
    })

    it('creates the brokered user on first sign-in without a profile-review page or account linking', () => {
      const firstLogin = flow(entra.firstBrokerLoginFlowAlias)
      expect(firstLogin.authenticationExecutions).toEqual([
        expect.objectContaining({ authenticator: 'idp-create-user-if-unique', requirement: 'REQUIRED' }),
      ])
    })

    it('holds no local users and no client allows a password or implicit grant', () => {
      expect(realm.users ?? []).toEqual([])
      for (const client of realm.clients) {
        expect(client.directAccessGrantsEnabled, client.clientId).toBe(false)
        expect(client.implicitFlowEnabled, client.clientId).toBe(false)
      }
    })
  })

  describe('the Entra identity provider (AD-6)', () => {
    it('re-syncs claims and roles from Entra on every sign-in (FORCE)', () => {
      expect(entra.config.syncMode).toBe('FORCE')
      expect(mappers.length).toBeGreaterThan(0)
      for (const mapper of mappers) expect(mapper.config.syncMode, mapper.name).toBe('FORCE')
    })

    it('rejects tokens from any tenant but ours by filtering on the tid claim', () => {
      expect(entra.config).toMatchObject({
        filteredByClaim: 'true',
        claimFilterName: 'tid',
        claimFilterValue: '${SR_ENTRA_TENANT_ID}',
      })
    })

    it('forwards max_age and prompt to Entra so Entra itself re-prompts on re-authentication (TQ-5)', () => {
      const forwarded = String(entra.config.forwardParameters)
        .split(',')
        .map((name) => name.trim())
      expect(forwarded).toEqual(expect.arrayContaining(['max_age', 'prompt']))
      /* A fixed prompt would replace the one the BFF sends; it must stay unset so prompt=login passes through. */
      expect(entra.config.prompt ?? '').toBe('')
    })

    it('validates Entra signatures against its JWKS, pins the issuer and uses PKCE', () => {
      expect(entra.config).toMatchObject({
        validateSignature: 'true',
        useJwksUrl: 'true',
        pkceEnabled: 'true',
        pkceMethod: 'S256',
        issuer: '${SR_ENTRA_ISSUER}',
      })
    })

    it('never stores Entra tokens and never trusts the email claim for identity', () => {
      expect(entra.storeToken).toBe(false)
      expect(entra.trustEmail).toBe(false)
      const username = mappers.find((mapper) => mapper.identityProviderMapper === 'oidc-username-idp-mapper')
      expect(username.config.template).toBe('${CLAIM.oid}')
    })

    it('takes every endpoint and the client credentials from the environment, never a literal host', () => {
      for (const key of [
        'authorizationUrl',
        'tokenUrl',
        'jwksUrl',
        'logoutUrl',
        'issuer',
        'clientId',
        'clientSecret',
      ]) {
        expect(isPlaceholder(entra.config[key]), key).toBe(true)
      }
    })
  })

  describe('role mapping from Entra app roles (AC-2, AC-3, AC-5)', () => {
    const roleMappers = mappers.filter((mapper) => mapper.identityProviderMapper === 'oidc-role-idp-mapper')
    const mapped = Object.fromEntries(roleMappers.map((mapper) => [mapper.config['claim.value'], mapper.config.role]))

    it('maps the Entra reader app role to reader and the administrator app role to report-admin', () => {
      expect(mapped).toEqual({ 'SignInReports.Reader': 'reader', 'SignInReports.Admin': 'report-admin' })
      for (const mapper of roleMappers) expect(mapper.config.claim).toBe('roles')
    })

    it('defines both target roles in the realm', () => {
      const names = realm.roles.realm.map((role: Json) => role.name)
      expect(names).toEqual(expect.arrayContaining(['reader', 'report-admin']))
    })

    it('grants neither role by default, so an account outside both groups is denied (AC-5)', () => {
      const defaultRole = realm.roles.realm.find((role: Json) => role.name === realm.defaultRole.name)
      const composites: string[] = defaultRole?.composites?.realm ?? []
      expect(composites).not.toContain('reader')
      expect(composites).not.toContain('report-admin')
      expect(realm.groups ?? []).toEqual([])
    })
  })

  describe('the BFF client (AC-7, AC-8)', () => {
    it('is a confidential, code-flow-only client with PKCE and no service account', () => {
      expect(bff).toMatchObject({
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        clientAuthenticatorType: 'client-secret',
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
      })
      expect(bff.attributes['pkce.code.challenge.method']).toBe('S256')
      expect(bff.attributes['oauth2.device.authorization.grant.enabled']).toBe('false')
      expect(bff.attributes['oidc.ciba.grant.enabled']).toBe('false')
    })

    it('redirects only to the dashboard callback on the public origin, with no browser origins allowed', () => {
      expect(bff.redirectUris).toEqual(['${SR_PUBLIC_ORIGIN}/auth/callback'])
      expect(bff.webOrigins).toEqual([])
    })

    it('puts exactly the reader and report-admin roles into a flat roles claim', () => {
      expect(bff.fullScopeAllowed).toBe(false)
      const scope = realm.scopeMappings.find((mapping: Json) => mapping.client === 'signin-reports-bff')
      expect([...scope.roles].sort()).toEqual(['reader', 'report-admin'])
      const roles = bff.protocolMappers.find(
        (mapper: Json) => mapper.protocolMapper === 'oidc-usermodel-realm-role-mapper',
      )
      expect(roles.config).toMatchObject({
        'claim.name': 'roles',
        multivalued: 'true',
        'access.token.claim': 'true',
        'id.token.claim': 'true',
      })
    })

    it('issues auth_time through the basic scope so the BFF can enforce step-up age (TQ-5)', () => {
      expect(bff.defaultClientScopes).toContain('basic')
    })
  })

  describe('session limits (AC-9)', () => {
    it('ends sessions after 15 minutes idle or 8 hours in total', () => {
      expect(realm.ssoSessionIdleTimeout).toBe(900)
      expect(realm.ssoSessionMaxLifespan).toBe(28800)
      expect(realm.clientSessionIdleTimeout).toBe(900)
      expect(realm.clientSessionMaxLifespan).toBe(28800)
    })

    it('keeps access tokens short and refresh tokens single-use, with no offline access', () => {
      expect(realm.accessTokenLifespan).toBeLessThanOrEqual(300)
      expect(realm.revokeRefreshToken).toBe(true)
      expect(realm.refreshTokenMaxReuse).toBe(0)
      const offline = realm.roles.realm.find((role: Json) => role.name === 'offline_access')
      expect(offline).toBeUndefined()
    })
  })

  describe('audit (AC-5)', () => {
    it('records login, login-error and broker events so a denied sign-in leaves a trail', () => {
      expect(realm.eventsEnabled).toBe(true)
      expect(realm.enabledEventTypes).toEqual(
        expect.arrayContaining(['LOGIN', 'LOGIN_ERROR', 'IDENTITY_PROVIDER_LOGIN_ERROR', 'LOGOUT']),
      )
      expect(realm.adminEventsEnabled).toBe(true)
      expect(realm.adminEventsDetailsEnabled).toBe(false)
    })
  })

  describe('no secret in the export (gate no-secret-in-iac)', () => {
    it('references every secret-like value only as an environment placeholder', () => {
      const secretKey = /(secret|password|privatekey|token)$/i
      for (const [path, key, value] of walk(realm)) {
        if (!secretKey.test(key) || typeof value !== 'string') continue
        expect(isPlaceholder(value), [...path, key].join('.')).toBe(true)
      }
    })

    it('holds no credentials, no key material and no realm keys', () => {
      expect(raw).not.toMatch(/"credentials"\s*:/)
      expect(raw).not.toMatch(/BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/)
      expect(realm.components?.['org.keycloak.keys.KeyProvider']).toBeUndefined()
    })
  })

  describe('GovCloud portability', () => {
    it('names no Microsoft host or URL literally; the README documents each placeholder', () => {
      expect(raw).not.toMatch(/https?:\/\/(?!\$\{)/)
      expect(raw).not.toMatch(/microsoftonline|login\.windows\.net/)
      const readme = readText('README.md')
      for (const name of placeholders(raw)) expect(readme, name).toContain(`\`${name}\``)
    })
  })
})
