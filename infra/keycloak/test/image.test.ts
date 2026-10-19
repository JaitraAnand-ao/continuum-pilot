/* The FIPS Keycloak 26.8.1 image production runs (AD-6, rubric fips-and-hardening). */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { keycloakDir, readText } from './load.js'

const dockerfile = readText('Dockerfile')
const conf = readText('conf/keycloak.conf')
const instructions = dockerfile
  .replace(/\\\n/g, ' ')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

describe('Dockerfile', () => {
  it('builds from Keycloak 26.8.1 pinned by digest in every stage', () => {
    const froms = instructions.filter((line) => line.startsWith('FROM '))
    expect(froms.length).toBeGreaterThan(0)
    for (const from of froms) expect(from).toMatch(/^FROM quay\.io\/keycloak\/keycloak:26\.8\.1@\$\{KEYCLOAK_DIGEST\}/)
    expect(dockerfile).toMatch(/^ARG KEYCLOAK_DIGEST$/m)
  })

  it('adds the BouncyCastle FIPS providers and verifies each jar by SHA-256', () => {
    for (const jar of ['bc-fips', 'bctls-fips', 'bcpkix-fips', 'bcutil-fips']) {
      expect(dockerfile).toContain(`${jar}-`)
    }
    expect(dockerfile).toMatch(/sha256sum (-c|--check)/)
  })

  it('builds with the fips feature in strict mode for PostgreSQL', () => {
    const build = instructions.find((line) => line.includes('kc.sh build')) ?? ''
    expect(build).toContain('--features=fips')
    expect(build).toContain('--fips-mode=strict')
    expect(build).toContain('--db=postgres')
  })

  it('imports only the signin-reports realm', () => {
    const copies = instructions.filter((line) => line.startsWith('COPY') && line.includes('realms/'))
    expect(copies).toEqual([
      expect.stringMatching(
        /realms\/signin-reports-realm\.json \/opt\/keycloak\/data\/import\/signin-reports-realm\.json$/,
      ),
    ])
  })

  it('runs as the non-root keycloak user through the bootstrap-admin guard', () => {
    const users = instructions.filter((line) => line.startsWith('USER '))
    expect(users.at(-1)).toBe('USER 1000')
    expect(instructions.find((line) => line.startsWith('ENTRYPOINT'))).toBe(
      'ENTRYPOINT ["/opt/keycloak/bin/docker-entrypoint.sh"]',
    )
    expect(instructions.find((line) => line.startsWith('CMD'))).toBe('CMD ["start", "--optimized", "--import-realm"]')
  })

  it('bakes no secret or admin credential into the image', () => {
    const env = instructions.filter((line) => /^(ENV|ARG) /.test(line))
    for (const line of env) expect(line).not.toMatch(/PASSWORD|SECRET|BOOTSTRAP_ADMIN|KEYCLOAK_ADMIN/)
  })
})

describe('keycloak.conf', () => {
  const options = Object.fromEntries(
    conf
      .split('\n')
      .filter((line) => /^[a-z]/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
  )

  it('runs FIPS strict with BCFKS key and trust stores', () => {
    expect(options['features']).toBe('fips')
    expect(options['fips-mode']).toBe('strict')
    expect(options['https-key-store-type']).toBe('bcfks')
    expect(options['https-key-store-file']).toMatch(/\.bcfks$/)
    expect(options['truststore-paths']).toMatch(/\.pem$/)
  })

  it('serves TLS only, behind the ALB, with the management interface off the public port', () => {
    expect(options['http-enabled']).toBe('false')
    expect(options['https-port']).toBe('8443')
    expect(options['https-protocols']).toBe('TLSv1.3,TLSv1.2')
    expect(options['proxy-headers']).toBe('xforwarded')
    expect(options['hostname-strict']).toBe('true')
    expect(options['http-management-port']).toBe('9000')
    expect(options['health-enabled']).toBe('true')
  })

  it('keeps no secret: passwords come from the task definition secrets as KC_* variables', () => {
    for (const name of Object.keys(options)) expect(name).not.toMatch(/password|secret/)
  })

  it('resolves vault references from the files ECS mounts', () => {
    expect(options['vault']).toBe('file')
    expect(options['vault-dir']).toBe('/opt/keycloak/vault')
  })
})

describe('docker-entrypoint.sh: the bootstrap admin must be gone before Keycloak starts', () => {
  const script = join(keycloakDir, 'docker-entrypoint.sh')
  const stubDir = mkdtempSync(join(tmpdir(), 'kc-entrypoint-'))
  const stub = join(stubDir, 'kc.sh')
  const record = join(stubDir, 'args')
  writeFileSync(stub, `#!/bin/sh\nprintf '%s ' "$@" > '${record}'\n`)
  chmodSync(stub, 0o755)

  function run(env: Record<string, string>) {
    writeFileSync(record, '')
    return spawnSync('bash', [script, 'start', '--optimized', '--import-realm'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', KC_SH: stub, ...env },
      encoding: 'utf8',
    })
  }

  it('starts Keycloak with the given arguments when no bootstrap admin is configured', () => {
    const result = run({})
    expect(result.status).toBe(0)
    expect(readFileSync(record, 'utf8').trim()).toBe('start --optimized --import-realm')
  })

  for (const name of [
    'KC_BOOTSTRAP_ADMIN_USERNAME',
    'KC_BOOTSTRAP_ADMIN_PASSWORD',
    'KC_BOOTSTRAP_ADMIN_CLIENT_ID',
    'KC_BOOTSTRAP_ADMIN_CLIENT_SECRET',
    'KEYCLOAK_ADMIN',
    'KEYCLOAK_ADMIN_PASSWORD',
  ]) {
    it(`fails the deployment when ${name} remains in the task definition`, () => {
      const result = run({ [name]: 'anything' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(name)
      expect(readFileSync(record, 'utf8')).toBe('')
    })
  }

  it('fails when the server is started without FIPS strict mode', () => {
    const result = spawnSync('bash', [script, 'start', '--fips-mode=non-strict'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', KC_SH: stub },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/fips-mode/)
  })

  it('refuses start-dev, which disables TLS and FIPS', () => {
    const dev = spawnSync('bash', [script, 'start-dev'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', KC_SH: stub },
      encoding: 'utf8',
    })
    expect(dev.status).not.toBe(0)
  })
})
