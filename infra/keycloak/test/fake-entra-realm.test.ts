/* The fake-entra realm stands in for Entra ID locally and in CI (never in the production
   image). Its users carry the claims Entra issues; signin.integration.test.ts signs each of them
   in through the signin-reports broker to prove the role mapping and denial the story needs. */
import { describe, expect, it } from 'vitest'
import { asObject, asObjects, placeholder, readJson, readText, stringLeaves, type JsonObject } from './load.js'

const fake = readJson('realms/local/fake-entra-realm.json')
const realm = readJson('realms/signin-reports-realm.json')
const broker = asObjects(fake.clients).find((client) => client.clientId === 'signin-reports-broker') ?? {}

function envFile(relative: string): Record<string, string> {
  return Object.fromEntries(
    readText(relative)
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

const local = envFile('env/local.env')
const gov = envFile('env/aws-us-gov.env.tftpl')

/** The oid claim fake-entra issues for a user: the username the signin-reports broker keeps. */
function oidOf(username: string): string {
  const user = asObjects(fake.users).find((candidate) => candidate.username === username)
  return String((asObject(user?.attributes).oid as string[] | undefined)?.[0] ?? '')
}

describe('realm fake-entra', () => {
  it('is a separate local realm, never imported by the production image', () => {
    expect(fake.realm).toBe('fake-entra')
    expect(readText('Dockerfile')).not.toMatch(/fake-entra/)
  })

  it('issues roles, tid and oid claims the way Entra does', () => {
    const mappers = asObjects(broker.protocolMappers)
    const roles = mappers.find((mapper) => mapper.protocolMapper === 'oidc-usermodel-client-role-mapper')
    expect(asObject(roles?.config)['claim.name']).toBe('roles')
    expect(asObject(roles?.config)['usermodel.clientRoleMapping.clientId']).toBe('signin-reports-broker')
    expect(asObject(roles?.config)['id.token.claim']).toBe('true')
    const attributes = mappers
      .filter((mapper) => mapper.protocolMapper === 'oidc-usermodel-attribute-mapper')
      .map((mapper) => asObject(mapper.config)['claim.name'])
    expect(attributes).toEqual(expect.arrayContaining(['tid', 'oid']))
  })

  it('keeps the tid and oid user attributes (unmanaged attributes enabled)', () => {
    const profile = asObjects(asObject(fake.components)['org.keycloak.userprofile.UserProfileProvider'])[0]
    const json = String((asObject(profile?.config)['kc.user.profile.config'] as string[] | undefined)?.[0] ?? '{}')
    expect(JSON.parse(json).unmanagedAttributePolicy).toBe('ENABLED')
  })

  it('defines the two Entra app roles the signin-reports mappers look for', () => {
    const appRoles = asObjects(asObject(asObject(fake.roles).client)['signin-reports-broker']).map((role) => role.name)
    expect(appRoles.sort()).toEqual(['SignInReports.Admin', 'SignInReports.Reader'])
  })

  it('redirects only to the signin-reports broker endpoint', () => {
    expect(broker.redirectUris).toEqual(['${KEYCLOAK_PUBLIC_ORIGIN}/realms/signin-reports/broker/entra/endpoint'])
    expect(broker.secret).toBe('${ENTRA_CLIENT_SECRET}')
    expect(broker.directAccessGrantsEnabled).toBe(false)
  })

  it('TQ-5: uses the built-in browser flow, which honours max_age and prompt=login', () => {
    expect(fake.browserFlow ?? 'browser').toBe('browser')
    expect(asObject(broker.authenticationFlowBindingOverrides)).toEqual({})
  })

  it('every user has a distinct oid, the username Keycloak keeps', () => {
    const oids = asObjects(fake.users).map((user) => oidOf(String(user.username)))
    expect(oids.every((oid) => /^[0-9a-f-]{36}$/.test(oid))).toBe(true)
    expect(new Set(oids).size).toBe(oids.length)
  })

  it('holds no password or secret value, only placeholders', () => {
    const credentials = asObjects(fake.users).flatMap((user) => asObjects(user.credentials))
    expect(credentials.length).toBeGreaterThan(0)
    for (const credential of credentials) expect(credential.value).toBe('${FAKE_ENTRA_USER_PASSWORD}')
    const leaves = stringLeaves(fake).filter(([path]) => /secret|password/i.test(path.split('.').pop() ?? ''))
    for (const [path, value] of leaves) expect(value, path).toMatch(placeholder)
  })
})

describe('environment files fill every realm placeholder', () => {
  const names = (document: JsonObject) =>
    [
      ...new Set(
        stringLeaves(document).flatMap(([, value]) => [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1])),
      ),
    ].filter((name) => !/SECRET|PASSWORD/.test(String(name)))

  it('local.env points the entra broker at fake-entra', () => {
    for (const name of names(realm)) expect(local, String(name)).toHaveProperty(String(name))
    expect(local.ENTRA_ISSUER).toBe(`${local.KEYCLOAK_PUBLIC_ORIGIN}/realms/fake-entra`)
  })

  it('aws-us-gov.env.tftpl uses the US Government Entra cloud over https only', () => {
    for (const name of names(realm)) expect(gov, String(name)).toHaveProperty(String(name))
    for (const [name, value] of Object.entries(gov).filter(([key]) => key.endsWith('_URL') || key === 'ENTRA_ISSUER')) {
      expect(value, name).toMatch(/^https:\/\/login\.microsoftonline\.us\//)
    }
    expect(gov.ENTRA_ISSUER).toBe('https://login.microsoftonline.us/${entra_tenant_id}/v2.0')
  })

  it('neither file carries a secret', () => {
    for (const env of [local, gov]) {
      expect(Object.keys(env).filter((name) => /SECRET|PASSWORD|PRIVATE|_KEY$/.test(name))).toEqual([])
    }
  })
})
