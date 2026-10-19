import { describe, expect, it } from 'vitest'
import { readText } from './load'

/* The FIPS Keycloak image (AD-6): digest-pinned 26.8.1 base, BouncyCastle FIPS providers
 * verified by checksum, fips-mode=strict, BCFKS keystores, non-root, only the production
 * realm baked in, and the bootstrap-admin guard as its entrypoint. */

const dockerfile = readText('Dockerfile')
const conf = readText('conf/keycloak.conf')
const lines = dockerfile.split('\n').map((line) => line.trim())
const instructions = (keyword: string): string[] => lines.filter((line) => line.startsWith(`${keyword} `))

const option = (name: string): string | undefined =>
  conf
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)

describe('Keycloak image', () => {
  it('builds every stage from the Keycloak 26.8.1 base pinned by digest', () => {
    expect(dockerfile).toMatch(/^ARG KEYCLOAK_VERSION=26\.8\.1$/m)
    const froms = instructions('FROM')
    expect(froms.length).toBeGreaterThanOrEqual(2)
    for (const from of froms) {
      expect(from).toMatch(/^FROM quay\.io\/keycloak\/keycloak:\$\{KEYCLOAK_VERSION\}@\$\{KEYCLOAK_DIGEST\}( AS \w+)?$/)
    }
    /* No default: a build without the reviewed digest must fail rather than float. */
    expect(dockerfile).toMatch(/^ARG KEYCLOAK_DIGEST$/m)
  })

  it('adds the three BouncyCastle FIPS jars, each verified against a checksum', () => {
    const adds = instructions('ADD')
    for (const jar of ['bc-fips', 'bctls-fips', 'bcutil-fips']) {
      const add = adds.find((line) => line.includes(`/${jar}-`))
      expect(add, jar).toMatch(/--checksum=sha256:\$\{\w+_SHA256\}/)
      expect(add).toContain('https://repo1.maven.org/maven2/org/bouncycastle/')
      expect(add).toMatch(/\/opt\/keycloak\/providers\/$/)
    }
  })

  it('turns on FIPS in strict mode with BCFKS keystores and TLS only', () => {
    expect(option('features')).toBe('fips')
    expect(option('fips-mode')).toBe('strict')
    expect(option('https-key-store-type')).toBe('bcfks')
    expect(option('https-trust-store-type')).toBe('bcfks')
    expect(option('http-enabled')).toBe('false')
    expect(option('db')).toBe('postgres')
  })

  it('runs the optimized build as a non-root user', () => {
    expect(dockerfile).toMatch(/RUN \/opt\/keycloak\/bin\/kc\.sh build/)
    const users = instructions('USER')
    expect(users.at(-1)).toMatch(/^USER (1000|keycloak)$/)
    expect(dockerfile).toMatch(/^CMD \["start", "--optimized", "--import-realm"\]$/m)
  })

  it('bakes in only the production realm, never the local fake-entra realm', () => {
    const copies = instructions('COPY').join('\n')
    expect(copies).toContain('realms/signin-reports-realm.json /opt/keycloak/data/import/')
    expect(copies).not.toContain('realms/local')
    expect(dockerfile).not.toMatch(/COPY\s+realms\/\s/)
  })

  it('starts through the bootstrap-admin guard and carries no admin credential or secret', () => {
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/opt\/keycloak\/bin\/sr-entrypoint\.sh"\]$/m)
    expect(dockerfile).toContain('docker-entrypoint.sh /opt/keycloak/bin/sr-entrypoint.sh')
    expect(dockerfile).not.toMatch(/KC_BOOTSTRAP_ADMIN|KEYCLOAK_ADMIN/)
    for (const env of instructions('ENV')) expect(env).not.toMatch(/PASSWORD|SECRET/i)
    expect(conf).not.toMatch(/password|secret/i)
  })
})
