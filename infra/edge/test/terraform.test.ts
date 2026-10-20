import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { block, blocks, loadModule, resources, TERRAFORM_DIR } from './lib/alb.js'

const mod = loadModule()
const FIPS_POLICY = 'ELBSecurityPolicy-TLS13-1-2-FIPS-2023-04'
const rawSources = readdirSync(TERRAFORM_DIR)
  .filter((f) => f.endsWith('.tf.json') || f.endsWith('.tf') || f.endsWith('.tfvars'))
  .map((f) => ({ file: f, text: readFileSync(join(TERRAFORM_DIR, f), 'utf8') }))

describe('ALB (AD-19)', () => {
  const lbs = Object.values(resources(mod, 'aws_lb'))

  it('is one internet-facing application load balancer behind its own security group', () => {
    expect(lbs).toHaveLength(1)
    const lb = lbs[0]!
    expect(lb.load_balancer_type).toBe('application')
    expect(lb.internal).toBe(false)
    expect(lb.security_groups).toEqual(['${aws_security_group.alb.id}'])
  })

  it('drops invalid headers, mitigates desync strictly and keeps deletion protection', () => {
    const lb = lbs[0]!
    expect(lb.drop_invalid_header_fields).toBe(true)
    expect(lb.desync_mitigation_mode).toBe('strictest')
    expect(lb.enable_deletion_protection).toBe(true)
    expect(block(lb.access_logs).enabled).toBe(true)
  })
})

describe('listener (AD-19)', () => {
  const listeners = Object.values(resources(mod, 'aws_lb_listener'))

  it('has exactly one listener, HTTPS on 443 — no port 80, no redirect listener', () => {
    expect(listeners).toHaveLength(1)
    const l = listeners[0]!
    expect(l.port).toBe(443)
    expect(l.protocol).toBe('HTTPS')
  })

  it('terminates TLS with the FIPS TLS 1.3/1.2 policy and an ACM certificate of this partition', () => {
    const l = listeners[0]!
    expect(l.ssl_policy).toBe(FIPS_POLICY)
    expect(l.certificate_arn).toBe('${var.certificate_arn}')
    const pre = blocks(block(l.lifecycle).precondition)
    expect(pre.map((p) => p.condition)).toContain(
      '${startswith(var.certificate_arn, "arn:${data.aws_partition.current.partition}:acm:${var.region}:")}',
    )
  })

  it('sends HSTS and hides the server header on every response', () => {
    const l = listeners[0]!
    expect(String(l.routing_http_response_strict_transport_security_header_value)).toMatch(/max-age=\d{8,}/)
    expect(l.routing_http_response_server_enabled).toBe(false)
  })

  it('forwards unmatched requests to the api target group', () => {
    expect(block(listeners[0]!.default_action)).toEqual({
      type: 'forward',
      target_group_arn: '${aws_lb_target_group.api.arn}',
    })
  })

  it('attaches every rule to that listener with a unique priority', () => {
    const rules = Object.values(resources(mod, 'aws_lb_listener_rule'))
    expect(rules.length).toBeGreaterThan(0)
    for (const r of rules) expect(r.listener_arn).toBe('${aws_lb_listener.https.arn}')
    const priorities = rules.map((r) => r.priority)
    expect(new Set(priorities).size).toBe(priorities.length)
  })

  it('evaluates every admin and traversal deny before any forward to Keycloak', () => {
    const rules = Object.values(resources(mod, 'aws_lb_listener_rule'))
    const forwards = rules.filter((r) => block(r.action).type === 'forward').map((r) => Number(r.priority))
    const denies = rules
      .filter((r) => {
        const values = blocks(r.condition).flatMap((c) => blocks(c.path_pattern).flatMap((p) => p.values as string[]))
        return values.some((v) => /admin|master|\.\.|%2/.test(v))
      })
      .map((r) => Number(r.priority))
    expect(denies.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...denies)).toBeLessThan(Math.min(...forwards))
  })
})

describe('target groups re-encrypt (AD-19)', () => {
  const tgs = resources(mod, 'aws_lb_target_group')

  it('are exactly api and keycloak, Fargate ip targets over HTTPS', () => {
    expect(Object.keys(tgs).sort()).toEqual(['api', 'keycloak'])
    for (const tg of Object.values(tgs)) {
      expect(tg.protocol).toBe('HTTPS')
      expect(tg.target_type).toBe('ip')
      expect(tg.vpc_id).toBe('${var.vpc_id}')
      expect(block(tg.health_check).protocol).toBe('HTTPS')
    }
  })

  it('sends Keycloak traffic to 8443 and checks health on the management port, which no rule routes', () => {
    const kc = tgs.keycloak!
    expect(kc.port).toBe('${var.keycloak_port}')
    const hc = block(kc.health_check)
    expect(hc.port).toBe('${var.keycloak_management_port}')
    expect(hc.path).toBe('/health/ready')
    const vars = mod.variable as Record<string, { default?: unknown }>
    expect(vars.keycloak_port!.default).toBe(8443)
    expect(vars.keycloak_management_port!.default).toBe(9000)
  })

  it('checks the api on its readiness path', () => {
    expect(tgs.api!.port).toBe('${var.api_port}')
    expect(block(tgs.api!.health_check).path).toBe('${var.api_health_path}')
  })
})

describe('security group (no-admin-exposure gate)', () => {
  it('admits the internet on 443/tcp only', () => {
    const ingress = Object.values(resources(mod, 'aws_vpc_security_group_ingress_rule'))
    expect(ingress).toHaveLength(1)
    const rule = ingress[0]!
    expect(rule.security_group_id).toBe('${aws_security_group.alb.id}')
    expect([rule.ip_protocol, rule.from_port, rule.to_port]).toEqual(['tcp', 443, 443])
    expect(resources(mod, 'aws_security_group').alb!.ingress).toBeUndefined()
  })

  it('reaches only the api and Keycloak task security groups, on their target and health ports', () => {
    const egress = Object.values(resources(mod, 'aws_vpc_security_group_egress_rule'))
    const pairs = egress.map((e) => `${String(e.referenced_security_group_id)}:${String(e.from_port)}`).sort()
    expect(pairs).toEqual([
      '${var.api_security_group_id}:${var.api_port}',
      '${var.keycloak_security_group_id}:${var.keycloak_management_port}',
      '${var.keycloak_security_group_id}:${var.keycloak_port}',
    ])
    for (const e of egress) {
      expect(e.cidr_ipv4).toBeUndefined()
      expect(e.from_port).toBe(e.to_port)
    }
  })
})

describe('GovCloud portable', () => {
  it('uses FIPS endpoints for the provider and the state backend', () => {
    const provider = block((mod.provider as Record<string, unknown>).aws)
    expect(provider.use_fips_endpoint).toBe(true)
    expect(provider.region).toBe('${var.region}')
    const backend = block(block(block((mod.terraform as Record<string, unknown>).backend).s3 ?? {}))
    expect(backend.use_fips_endpoint).toBe(true)
  })

  it('hard-codes no ARN: every arn: literal takes its partition from aws_partition', () => {
    for (const { file, text } of rawSources) {
      expect(text, file).not.toMatch(/arn:aws(-us-gov|-cn)?:/)
      for (const m of text.matchAll(/arn:([^:"]*):/g)) {
        expect(m[1], file).toBe('${data.aws_partition.current.partition}')
      }
    }
    expect((mod.data as Record<string, Record<string, unknown>>).aws_partition?.current).toBeDefined()
  })

  it('accepts GovCloud regions', () => {
    const region = (mod.variable as Record<string, Record<string, unknown>>).region!
    const condition = String(block(region.validation).condition)
    const pattern = /regex\("(.+)", var\.region\)/.exec(condition)?.[1]?.replace(/\\\\/g, '\\')
    expect(pattern).toBeDefined()
    const re = new RegExp(pattern!)
    for (const ok of ['us-gov-west-1', 'us-gov-east-1', 'us-east-1']) expect(re.test(ok), ok).toBe(true)
    for (const bad of ['us-gov-west', 'mars-1', '']) expect(re.test(bad), bad).toBe(false)
  })
})

describe('no-secret-in-iac gate', () => {
  it('carries no secret, key or certificate material', () => {
    expect(rawSources.length).toBeGreaterThan(0)
    for (const { file, text } of rawSources) {
      expect(text, file).not.toMatch(/BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/)
      expect(text, file).not.toMatch(/AKIA[0-9A-Z]{16}/)
      expect(text, file).not.toMatch(/"(password|secret|client_secret|token)"\s*:/i)
    }
  })

  it('ships no tfvars file', () => {
    expect(rawSources.map((s) => s.file)).toContain('variables.tf.json')
    expect(rawSources.filter((s) => s.file.endsWith('.tfvars'))).toEqual([])
  })
})
