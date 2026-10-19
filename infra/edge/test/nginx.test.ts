/* CMP-10 / AD-19: the local edge. The Compose nginx must follow the same routing table
 * as the ALB, terminate TLS with FIPS-approved suites only, and re-encrypt upstream. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { find, parse, route, servers, value, type Directive, type Outcome } from './nginx'
import { routingCases, type Destination } from './routes'

const path = join(import.meta.dirname, '..', 'nginx', 'default.conf')
const config = existsSync(path) ? parse(readFileSync(path, 'utf8')) : []
const all = servers(config)

function server(): Directive {
  expect(all).toHaveLength(1)
  return all[0] as Directive
}

function destination(outcome: Outcome | undefined): Destination | undefined {
  if (!outcome) return undefined
  if (outcome.kind === 'status') return outcome.code >= 400 ? 'denied' : undefined
  if (outcome.upstream === 'https://api') return 'api'
  if (outcome.upstream === 'https://keycloak') return 'keycloak'
  return undefined
}

const fipsTls12Suites = new Set([
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
])

describe('edge nginx TLS', () => {
  it('has one server, listening on 443 with TLS and nowhere else', () => {
    const listens = find(server().children ?? [], 'listen').map((l) => l.args)
    expect(listens.length).toBeGreaterThan(0)
    for (const args of listens) {
      expect(args[0]).toMatch(/(^|:)443$/)
      expect(args).toContain('ssl')
    }
  })

  it('offers TLS 1.2 and 1.3 only, with FIPS-approved suites and curves', () => {
    const children = server().children ?? []
    expect(value(children, 'ssl_protocols')).toEqual(['TLSv1.2', 'TLSv1.3'])
    const ciphers = (value(children, 'ssl_ciphers')?.[0] ?? '').split(':')
    expect(ciphers.length).toBeGreaterThan(0)
    for (const cipher of ciphers) expect(fipsTls12Suites.has(cipher)).toBe(true)
    const curves = (value(children, 'ssl_ecdh_curve')?.[0] ?? '').split(':')
    expect(curves.length).toBeGreaterThan(0)
    for (const curve of curves) expect(['prime256v1', 'secp384r1']).toContain(curve)
    expect(value(children, 'ssl_prefer_server_ciphers')).toEqual(['on'])
  })

  it('uses the certificate npm run certs:local writes, never a committed one', () => {
    const children = server().children ?? []
    expect(value(children, 'ssl_certificate')).toEqual(['/etc/nginx/certs/cert.pem'])
    expect(value(children, 'ssl_certificate_key')).toEqual(['/etc/nginx/certs/key.pem'])
  })

  it('hides its version and sends HSTS', () => {
    const children = server().children ?? []
    expect(value(children, 'server_tokens')).toEqual(['off'])
    const hsts = find(children, 'add_header').find((h) => h.args[0] === 'Strict-Transport-Security')
    expect(hsts?.args[1]).toMatch(/max-age=\d{8,}/)
  })
})

describe('edge nginx re-encrypts to the services', () => {
  it('defines api and keycloak upstreams', () => {
    const http = config.find((d) => d.name === 'upstream')
      ? config
      : (config.find((d) => d.name === 'http')?.children ?? [])
    expect(find(http, 'upstream').map((u) => u.args[0])).toEqual(['api', 'keycloak'])
  })

  it('verifies the upstream certificate on every proxied location', () => {
    const proxied = find(server().children ?? [], 'location').filter((l) => value(l.children ?? [], 'proxy_pass'))
    expect(proxied.length).toBeGreaterThan(0)
    for (const location of proxied) {
      const children = location.children ?? []
      expect(value(children, 'proxy_pass')?.[0]).toMatch(/^https:\/\//)
    }
    const children = server().children ?? []
    expect(value(children, 'proxy_ssl_verify')).toEqual(['on'])
    expect(value(children, 'proxy_ssl_protocols')).toEqual(['TLSv1.2', 'TLSv1.3'])
    expect(value(children, 'proxy_ssl_trusted_certificate')).toEqual(['/etc/nginx/certs/cert.pem'])
  })

  it('forwards the original host, scheme and client address', () => {
    const headers = find(server().children ?? [], 'proxy_set_header').map((h) => h.args[0])
    expect(headers).toEqual(expect.arrayContaining(['Host', 'X-Forwarded-Proto', 'X-Forwarded-For']))
  })
})

describe('edge nginx routing mirrors the ALB (AD-19)', () => {
  for (const { raw, normalised, expected } of routingCases) {
    it(`${raw} → ${expected}`, () => {
      expect(destination(route(server(), raw, normalised ?? raw))).toBe(expected)
    })
  }
})
