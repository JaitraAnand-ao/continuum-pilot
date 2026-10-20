import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { all, parseNginx } from './lib/nginx.js'

/* The local stand-in must behave like the ALB listener: TLS on 443 only, the FIPS
 * cipher set, re-encryption to both upstreams, and the forwarding headers Keycloak
 * (proxy-headers=xforwarded) and the BFF trust for the __Host- session cookie (AC-8). */
const source = readFileSync(new URL('../nginx/edge.conf', import.meta.url), 'utf8')
const tree = parseNginx(source)
/* upstream blocks hold `server` directives too; a server context is the one with a block */
const server = all(tree, 'server').filter((s) => s.block)
const directive = (name: string) => all(tree, name).map((d) => d.args.join(' '))

describe('local edge nginx', () => {
  it('has one server and it listens on 443 with TLS only — nothing on port 80', () => {
    expect(server).toHaveLength(1)
    const listens = directive('listen')
    expect(listens.length).toBeGreaterThan(0)
    for (const l of listens) expect(l).toMatch(/^(\[::\]:)?443 ssl$/)
  })

  it('takes its certificate from the gitignored certs/local mount', () => {
    expect(directive('ssl_certificate')).toEqual(['/etc/nginx/certs/cert.pem'])
    expect(directive('ssl_certificate_key')).toEqual(['/etc/nginx/certs/key.pem'])
  })

  it('offers only TLS 1.2/1.3 with the AES-GCM suites of the ALB FIPS policy', () => {
    expect(directive('ssl_protocols')).toEqual(['TLSv1.2 TLSv1.3'])
    const ciphers = directive('ssl_ciphers')[0]!.split(':')
    for (const c of ciphers) expect(c).toMatch(/^ECDHE-(ECDSA|RSA)-AES(128|256)-GCM-SHA(256|384)$/)
    expect(directive('ssl_conf_command')).toEqual(['Ciphersuites TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384'])
  })

  it('re-encrypts to both upstreams', () => {
    const passes = directive('proxy_pass')
    expect(passes.length).toBeGreaterThan(0)
    for (const p of passes) expect(p).toMatch(/^https:\/\//)
    expect(directive('proxy_ssl_protocols')).toEqual(['TLSv1.2 TLSv1.3'])
    expect(
      all(tree, 'upstream')
        .map((u) => u.args[0])
        .sort(),
    ).toEqual(['api', 'keycloak'])
    expect(
      directive('server')
        .filter((s) => /:/.test(s))
        .sort(),
    ).toEqual(['api:8443', 'keycloak:8443'])
  })

  it('forwards the original host, scheme and port so redirects and cookies stay on https://localhost', () => {
    const headers = directive('proxy_set_header')
    expect(headers).toEqual(
      expect.arrayContaining([
        'Host $host',
        'X-Forwarded-For $proxy_add_x_forwarded_for',
        'X-Forwarded-Proto https',
        'X-Forwarded-Host $host',
        'X-Forwarded-Port 443',
      ]),
    )
  })

  it('sends HSTS on every response and hides its version, like the ALB', () => {
    expect(directive('add_header')).toContain('Strict-Transport-Security max-age=31536000; includeSubDomains always')
    expect(directive('server_tokens')).toEqual(['off'])
  })
})
