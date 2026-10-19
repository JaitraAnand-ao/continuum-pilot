/* ST-1 in CMP-6 (AD-6): the signin-reports realm export is the only way the realm is
   configured. These tests read the committed export the image imports. */
import { describe, expect, it } from 'vitest'
import { asObject, asObjects, readJson, stringLeaves, type JsonObject } from './load.js'

const realm = readJson('realms/signin-reports-realm.json')
const providers = asObjects(realm.identityProviders)
const entra = providers[0] ?? {}
const entraConfig = asObject(entra.config)
const mappers = asObjects(realm.identityProviderMappers)
const flows = asObjects(realm.authenticationFlows)
const clients = asObjects(realm.clients)
const bff = clients.find((client) => client.clientId === 'signin-reports-bff') ?? {}

function flow(alias: unknown): JsonObject {
  return flows.find((candidate) => candidate.alias === alias) ?? {}
}

function authenticators(alias: unknown): string[] {
  return asObjects(flow(alias).authenticationExecutions).flatMap((execution) =>
    execution.authenticatorFlow === true ? authenticators(execution.flowAlias) : [String(execution.authenticator)],
  )
}

describe('realm signin-reports', () => {
  it('is the signin-reports realm, enabled, TLS for every request', () => {
    expect(realm.realm).toBe('signin-reports')
    expect(realm.enabled).toBe(true)
    expect(realm.sslRequired).toBe('all')
  })

  it('has no local accounts: no users, no registration, no password reset, no remember-me', () => {
    expect(realm.users ?? []).toEqual([])
    expect(realm.registrationAllowed).toBe(false)
    expect(realm.resetPasswordAllowed).toBe(false)
    expect(realm.rememberMe).toBe(false)
    expect(realm.editUsernameAllowed).toBe(false)
  })

  it('AC-9: ends a session after 15 minutes idle or 8 hours in total', () => {
    expect(realm.ssoSessionIdleTimeout).toBe(900)
    expect(realm.ssoSessionMaxLifespan).toBe(28800)
    expect(realm.clientSessionIdleTimeout ?? 0).toBeLessThanOrEqual(900)
    expect(realm.clientSessionMaxLifespan ?? 0).toBeLessThanOrEqual(28800)
  })

  it('AC-8: refresh tokens rotate and cannot be replayed', () => {
    expect(realm.revokeRefreshToken).toBe(true)
    expect(realm.refreshTokenMaxReuse).toBe(0)
    expect(Number(realm.accessTokenLifespan)).toBeLessThanOrEqual(300)
  })

  it('records sign-in and identity-provider errors as events (AC-5, AC-6 audit trail)', () => {
    expect(realm.eventsEnabled).toBe(true)
    expect(realm.adminEventsEnabled).toBe(true)
    expect(realm.enabledEventTypes).toEqual(
      expect.arrayContaining([
        'LOGIN',
        'LOGIN_ERROR',
        'IDENTITY_PROVIDER_LOGIN',
        'IDENTITY_PROVIDER_LOGIN_ERROR',
        'IDENTITY_PROVIDER_FIRST_LOGIN',
        'LOGOUT',
      ]),
    )
  })
})

describe('Entra ID is the only identity provider', () => {
  it('AC-1: exactly one provider, entra, an enabled OIDC broker', () => {
    expect(providers).toHaveLength(1)
    expect(entra.alias).toBe('entra')
    expect(entra.providerId).toBe('oidc')
    expect(entra.enabled).toBe(true)
  })

  it('FORCE-syncs the user and every mapper on each sign-in, so a removed app role is removed here', () => {
    expect(entraConfig.syncMode).toBe('FORCE')
    expect(mappers.length).toBeGreaterThan(0)
    for (const mapper of mappers) {
      expect(mapper.identityProviderAlias).toBe('entra')
      expect(asObject(mapper.config).syncMode, String(mapper.name)).toBe('FORCE')
    }
  })

  it('accepts only ID tokens whose tid is the organisation tenant', () => {
    expect(entraConfig.filteredByClaim).toBe('true')
    expect(entraConfig.claimFilterName).toBe('tid')
    expect(entraConfig.claimFilterValue).toBe('^${ENTRA_TENANT_ID}$')
  })

  it('TQ-5: forwards max_age and prompt to Entra so Entra itself re-prompts, not its SSO session', () => {
    const forwarded = String(entraConfig.forwardParameters ?? '').split(',')
    expect(forwarded).toEqual(expect.arrayContaining(['max_age', 'prompt']))
    /* A fixed prompt here would override the one the BFF sends. */
    expect(entraConfig.prompt ?? '').toBe('')
  })

  it('verifies signatures from the tenant JWKS, uses PKCE and keeps no Entra tokens', () => {
    expect(entraConfig.validateSignature).toBe('true')
    expect(entraConfig.useJwksUrl).toBe('true')
    expect(entraConfig.pkceEnabled).toBe('true')
    expect(entraConfig.pkceMethod).toBe('S256')
    expect(entraConfig.disableUserInfo).toBe('true')
    expect(entra.storeToken).toBe(false)
    expect(entra.addReadTokenRoleOnCreate).toBe(false)
    expect(entra.trustEmail).toBe(false)
    expect(entra.linkOnly).toBe(false)
  })

  it('takes every Entra endpoint from the environment, so aws-us-gov uses login.microsoftonline.us', () => {
    expect(entraConfig.issuer).toBe('${ENTRA_ISSUER}')
    expect(entraConfig.authorizationUrl).toBe('${ENTRA_AUTHORIZATION_URL}')
    expect(entraConfig.tokenUrl).toBe('${ENTRA_TOKEN_URL}')
    expect(entraConfig.jwksUrl).toBe('${ENTRA_JWKS_URL}')
    expect(entraConfig.logoutUrl).toBe('${ENTRA_LOGOUT_URL}')
    expect(entraConfig.clientId).toBe('${ENTRA_CLIENT_ID}')
    expect(entraConfig.clientSecret).toBe('${vault.entra_client_secret}')
  })

  it('names users by the immutable Entra object id, never by e-mail', () => {
    const username = mappers.find((mapper) => mapper.identityProviderMapper === 'oidc-username-idp-mapper')
    expect(asObject(username?.config).template).toBe('${CLAIM.oid}')
  })

  it('keeps tid and the display account name for the no-access screen (AC-5)', () => {
    const attributes = mappers
      .filter((mapper) => mapper.identityProviderMapper === 'oidc-user-attribute-idp-mapper')
      .map((mapper) => [asObject(mapper.config).claim, asObject(mapper.config)['user.attribute']])
    expect(attributes).toEqual(
      expect.arrayContaining([
        ['tid', 'tid'],
        ['preferred_username', 'entra_upn'],
        ['name', 'entra_name'],
      ]),
    )
  })
})

describe('browser sign-in goes straight to Entra', () => {
  it('AC-1: the browser flow has the cookie and the Entra redirector only, no password form', () => {
    expect(realm.browserFlow).toBe('entra only browser')
    expect(authenticators(realm.browserFlow).sort()).toEqual(['auth-cookie', 'identity-provider-redirector'])
    const redirector = asObjects(flow(realm.browserFlow).authenticationExecutions).find(
      (execution) => execution.authenticator === 'identity-provider-redirector',
    )
    const config = asObjects(realm.authenticatorConfig).find(
      (candidate) => candidate.alias === redirector?.authenticatorConfig,
    )
    expect(asObject(config?.config).defaultProvider).toBe('entra')
  })

  it('first sign-in creates the user silently, never asking for a profile or linking by e-mail', () => {
    expect(entra.firstBrokerLoginFlowAlias).toBe('entra first broker login')
    expect(authenticators(entra.firstBrokerLoginFlowAlias)).toEqual(['idp-create-user-if-unique'])
    expect(asObject(entraConfig).updateProfileFirstLoginMode ?? 'off').toBe('off')
  })

  it('no flow anywhere offers a local password, OTP or registration', () => {
    const local = [
      'auth-username-password-form',
      'auth-otp-form',
      'registration-page-form',
      'direct-grant-validate-password',
    ]
    const bound = [realm.browserFlow, realm.directGrantFlow, realm.registrationFlow, realm.resetCredentialsFlow]
    for (const alias of bound) {
      for (const authenticator of authenticators(alias)) expect(local).not.toContain(authenticator)
    }
  })
})

describe('roles', () => {
  const realmRoles = asObjects(asObject(realm.roles).realm).map((role) => role.name)

  it('defines reader and report-admin', () => {
    expect(realmRoles).toEqual(expect.arrayContaining(['reader', 'report-admin']))
  })

  it('AC-5: nobody holds a report role by default', () => {
    expect(asObject(realm.defaultRole).name).toBe('default-roles-signin-reports')
    const defaultRole = asObjects(asObject(realm.roles).realm).find(
      (role) => role.name === 'default-roles-signin-reports',
    )
    expect(defaultRole).toBeDefined()
    expect(JSON.stringify(defaultRole?.composites ?? {})).not.toMatch(/reader|report-admin/)
  })

  it('maps the Entra app roles in the roles claim to reader and report-admin', () => {
    const roleMappers = mappers
      .filter((mapper) => mapper.identityProviderMapper === 'oidc-role-idp-mapper')
      .map((mapper) => asObject(mapper.config))
      .map((config) => [config.claim, config['claim.value'], config.role])
    expect(roleMappers).toEqual(
      expect.arrayContaining([
        ['roles', 'SignInReports.Reader', 'reader'],
        ['roles', 'SignInReports.Admin', 'report-admin'],
      ]),
    )
    expect(roleMappers).toHaveLength(2)
  })
})

describe('client signin-reports-bff (the only client the BFF uses)', () => {
  const attributes = asObject(bff.attributes)

  it('is confidential and uses the authorization-code flow only', () => {
    expect(bff.enabled).toBe(true)
    expect(bff.publicClient).toBe(false)
    expect(bff.standardFlowEnabled).toBe(true)
    expect(bff.implicitFlowEnabled).toBe(false)
    expect(bff.directAccessGrantsEnabled).toBe(false)
    expect(bff.serviceAccountsEnabled).toBe(false)
    expect(bff.secret).toBe('${vault.bff_client_secret}')
    expect(attributes['pkce.code.challenge.method']).toBe('S256')
  })

  it('AC-8: has no web origins, so no browser can call the token endpoint for itself', () => {
    expect(bff.webOrigins ?? []).toEqual([])
  })

  it('redirects only to the BFF callback and the Sign in screen, no wildcards', () => {
    expect(bff.redirectUris).toEqual(['${SR_PUBLIC_ORIGIN}/auth/callback'])
    expect(attributes['post.logout.redirect.uris']).toBe('${SR_PUBLIC_ORIGIN}/signin')
  })

  it('AC-2, AC-3: puts realm roles, tid and the account name into the ID token', () => {
    const tokenMappers = asObjects(bff.protocolMappers)
    const roles = tokenMappers.find((mapper) => mapper.protocolMapper === 'oidc-usermodel-realm-role-mapper')
    expect(asObject(roles?.config)['claim.name']).toBe('roles')
    expect(asObject(roles?.config)['multivalued']).toBe('true')
    expect(asObject(roles?.config)['id.token.claim']).toBe('true')
    const claims = tokenMappers
      .filter((mapper) => mapper.protocolMapper === 'oidc-usermodel-attribute-mapper')
      .map((mapper) => [asObject(mapper.config)['user.attribute'], asObject(mapper.config)['claim.name']])
    expect(claims).toEqual(
      expect.arrayContaining([
        ['tid', 'tid'],
        ['entra_upn', 'preferred_username'],
        ['entra_name', 'name'],
      ]),
    )
  })

  it('is the only enabled client outside the built-in ones', () => {
    const builtIn = ['account', 'account-console', 'admin-cli', 'broker', 'realm-management', 'security-admin-console']
    const custom = clients.filter((client) => !builtIn.includes(String(client.clientId)))
    expect(custom.map((client) => client.clientId)).toEqual(['signin-reports-bff'])
    for (const client of clients) expect(client.directAccessGrantsEnabled ?? false).toBe(false)
  })
})

describe('no secrets in the export', () => {
  it('every secret, password or key value is a vault reference, never an import-time value', () => {
    const sensitive = /secret|password|credential|private|keystore|token$/i
    const leaves = stringLeaves(realm).filter(([path]) => sensitive.test(path.split('.').pop() ?? ''))
    expect(leaves.length).toBeGreaterThan(0)
    for (const [path, value] of leaves) expect(value, path).toMatch(/^\$\{vault\.[a-z0-9_]+\}$/)
  })

  it('commits no realm keys: Keycloak generates them at import', () => {
    expect(JSON.stringify(realm.components ?? {})).not.toMatch(/privateKey|certificate|"secret"/)
  })

  it('no endpoint is hard-coded to the commercial Entra cloud', () => {
    for (const [path, value] of stringLeaves(realm)) {
      expect(value, path).not.toMatch(/login\.microsoftonline\.com|graph\.microsoft\.com|login\.windows\.net/)
    }
  })
})
