import { describe, expect, it } from 'vitest'
import { fakeEntraRealmPath, isPlaceholder, readJson, readText, signinRealmPath, type Json } from './load'

/* The fake-entra realm stands in for Entra ID locally and in integration tests. It must emit
 * the claims the signin-reports realm relies on (oid, tid, roles) and cover every persona the
 * story exercises: reader only, reader + administrator, administrator only, neither, and an
 * account from a foreign tenant. */

const fake: Json = readJson(fakeEntraRealmPath)
const signin: Json = readJson(signinRealmPath)
const broker: Json = fake.clients?.find((client: Json) => client.clientId === 'signin-reports-broker')
const users: Json[] = fake.users ?? []
const user = (username: string): Json => users.find((candidate) => candidate.username === username)

const profileAttributes = (realm: Json): string[] => {
  const provider = realm.components['org.keycloak.userprofile.UserProfileProvider'][0]
  return JSON.parse(provider.config['kc.user.profile.config'][0]).attributes.map((attribute: Json) => attribute.name)
}

describe('fake-entra realm', () => {
  it('is a separate realm that production never imports', () => {
    expect(fake.realm).toBe('fake-entra')
    expect(fake.enabled).toBe(true)
  })

  it('has a confidential broker client whose only redirect is the signin-reports entra broker endpoint', () => {
    expect(broker).toMatchObject({
      publicClient: false,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      secret: '${FAKE_ENTRA_CLIENT_SECRET}',
    })
    expect(broker.redirectUris).toEqual(['${SR_PUBLIC_ORIGIN}/realms/signin-reports/broker/entra/endpoint'])
  })

  it('emits oid, tid and a flat roles claim the way Entra does', () => {
    const claims = Object.fromEntries(
      broker.protocolMappers.map((mapper: Json) => [mapper.config['claim.name'], mapper.protocolMapper]),
    )
    expect(claims).toMatchObject({
      oid: 'oidc-usermodel-property-mapper',
      tid: 'oidc-usermodel-attribute-mapper',
      roles: 'oidc-usermodel-client-role-mapper',
    })
    const roles = broker.protocolMappers.find((mapper: Json) => mapper.config['claim.name'] === 'roles')
    expect(roles.config['usermodel.clientRoleMapping.clientId']).toBe('signin-reports-broker')
    expect(roles.config.multivalued).toBe('true')
    expect(roles.config['id.token.claim']).toBe('true')
  })

  it('defines the same app-role values the signin-reports realm maps', () => {
    const appRoles = fake.roles.client['signin-reports-broker'].map((role: Json) => role.name).sort()
    const mapped = signin.identityProviderMappers
      .filter((mapper: Json) => mapper.identityProviderMapper === 'oidc-role-idp-mapper')
      .map((mapper: Json) => mapper.config['claim.value'])
      .sort()
    expect(appRoles).toEqual(mapped)
  })

  it('declares tid in the user profile so the attribute reaches the token', () => {
    expect(profileAttributes(fake)).toContain('tid')
    expect(profileAttributes(signin)).toEqual(expect.arrayContaining(['tid', 'upn']))
  })

  it.each([
    ['reader@fake-entra.test', ['SignInReports.Reader']],
    ['both@fake-entra.test', ['SignInReports.Admin', 'SignInReports.Reader']],
    ['admin-only@fake-entra.test', ['SignInReports.Admin']],
    ['outsider@fake-entra.test', []],
  ])('%s holds exactly %j in our tenant', (username, roles) => {
    const account = user(username)
    expect(account, username).toBeDefined()
    expect([...(account.clientRoles?.['signin-reports-broker'] ?? [])].sort()).toEqual(roles)
    expect(account.attributes.tid).toEqual(['${FAKE_ENTRA_TENANT_ID}'])
  })

  it('has a reader from a foreign tenant so the tid check can be proven', () => {
    const foreign = user('foreign@other-tenant.test')
    expect(foreign.clientRoles['signin-reports-broker']).toEqual(['SignInReports.Reader'])
    expect(foreign.attributes.tid).toHaveLength(1)
    expect(foreign.attributes.tid[0]).not.toBe('${FAKE_ENTRA_TENANT_ID}')
  })

  it('keeps every test password and the client secret out of the file', () => {
    for (const account of users) {
      for (const credential of account.credentials) expect(isPlaceholder(credential.value), account.username).toBe(true)
    }
    expect(readText(fakeEntraRealmPath)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  })
})
