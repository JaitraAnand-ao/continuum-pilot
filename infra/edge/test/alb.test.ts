/* CMP-10 / AD-19: the production edge. Reads the Terraform in ../terraform and checks
 * the listener, its rules and the target groups, then replays the shared routing table
 * through a model of ALB rule evaluation (priority order, first match, case-sensitive
 * path patterns with * and ?). */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attr, blocks, readModule, resource, resources, stringList, unquote, type Block } from './hcl'
import { routingCases, type Destination } from './routes'

const dir = join(import.meta.dirname, '..', 'terraform')
const module = existsSync(dir) ? readModule(dir) : []
const allSource = existsSync(dir)
  ? readdirSync(dir)
      .filter((name) => name.endsWith('.tf'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n')
  : ''

function nested(block: Block, kind: string): Block[] {
  return blocks(block.body).filter((b) => b.kind === kind)
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function destinationOf(action: Block): Destination {
  const type = unquote(attr(action.body, 'type'))
  if (type === 'forward') {
    const target = attr(action.body, 'target_group_arn') ?? ''
    if (target === 'aws_lb_target_group.api.arn') return 'api'
    if (target === 'aws_lb_target_group.keycloak.arn') return 'keycloak'
    throw new Error(`forward to an unexpected target group: ${target}`)
  }
  if (type === 'fixed-response') {
    const status = Number(unquote(attr(nested(action, 'fixed_response')[0]?.body ?? '', 'status_code')))
    if (status >= 400) return 'denied'
  }
  throw new Error(`action ${type} is neither a forward nor a refusal`)
}

function albRoute(path: string): Destination {
  const rules = resources(module, 'aws_lb_listener_rule')
    .map((rule) => ({ rule, priority: Number(attr(rule.body, 'priority')) }))
    .sort((a, b) => a.priority - b.priority)
  for (const { rule } of rules) {
    const patterns = nested(rule, 'condition').flatMap((c) =>
      nested(c, 'path_pattern').flatMap((p) => stringList(attr(p.body, 'values'))),
    )
    if (patterns.some((p) => globToRegExp(p).test(path))) {
      const action = nested(rule, 'action')[0]
      if (!action) throw new Error('listener rule without an action')
      return destinationOf(action)
    }
  }
  const listener = resource(module, 'aws_lb_listener', 'https')
  const fallback = nested(listener, 'default_action')[0]
  if (!fallback) throw new Error('the HTTPS listener has no default action')
  return destinationOf(fallback)
}

describe('ALB listener (AD-19)', () => {
  it('has exactly one listener, HTTPS on 443 with a FIPS TLS policy and the ACM certificate', () => {
    const listeners = resources(module, 'aws_lb_listener')
    expect(listeners.map((l) => l.labels[1])).toEqual(['https'])
    const https = resource(module, 'aws_lb_listener', 'https')
    expect(attr(https.body, 'port')).toBe('443')
    expect(unquote(attr(https.body, 'protocol'))).toBe('HTTPS')
    expect(unquote(attr(https.body, 'ssl_policy'))).toMatch(/^ELBSecurityPolicy-TLS13-1-2-(Res-)?FIPS-\d{4}-\d{2}$/)
    expect(attr(https.body, 'certificate_arn')).toBe('var.certificate_arn')
  })

  it('never listens on port 80 or plain HTTP', () => {
    expect(resources(module, 'aws_lb_listener')).not.toEqual([])
    expect(allSource).not.toMatch(/port\s*=\s*"?80"?\s*$/m)
    expect(allSource).not.toMatch(/protocol\s*=\s*"HTTP"/)
  })

  it('is internet-facing, drops invalid headers, mitigates desync strictly and keeps access logs', () => {
    const lb = resource(module, 'aws_lb', 'edge')
    expect(unquote(attr(lb.body, 'load_balancer_type'))).toBe('application')
    expect(attr(lb.body, 'internal')).toBe('false')
    expect(attr(lb.body, 'drop_invalid_header_fields')).toBe('true')
    expect(unquote(attr(lb.body, 'desync_mitigation_mode'))).toBe('strictest')
    expect(attr(lb.body, 'enable_deletion_protection')).toBe('true')
    const logs = nested(lb, 'access_logs')[0]
    expect(logs && attr(logs.body, 'enabled')).toBe('true')
  })
})

describe('ALB security group (no-admin-exposure)', () => {
  it('admits the internet on 443 only', () => {
    const ingress = resources(module, 'aws_vpc_security_group_ingress_rule').filter((r) =>
      (attr(r.body, 'security_group_id') ?? '').startsWith('aws_security_group.alb'),
    )
    expect(ingress.length).toBeGreaterThan(0)
    for (const rule of ingress) {
      expect(attr(rule.body, 'from_port')).toBe('443')
      expect(attr(rule.body, 'to_port')).toBe('443')
      expect(unquote(attr(rule.body, 'ip_protocol'))).toBe('tcp')
    }
    expect(resources(module, 'aws_security_group_rule')).toEqual([])
    expect(nested(resource(module, 'aws_security_group', 'alb'), 'ingress')).toEqual([])
  })

  it('lets the ALB reach only the api and Keycloak security groups, never the internet', () => {
    const egress = resources(module, 'aws_vpc_security_group_egress_rule')
    expect(egress.length).toBeGreaterThan(0)
    for (const rule of egress) {
      expect(attr(rule.body, 'cidr_ipv4')).toBeUndefined()
      expect(attr(rule.body, 'cidr_ipv6')).toBeUndefined()
      expect(attr(rule.body, 'referenced_security_group_id')).toMatch(/^var\.(api|keycloak)_security_group_id$/)
    }
  })
})

describe('target groups re-encrypt to the services', () => {
  for (const name of ['api', 'keycloak']) {
    it(`${name} is an HTTPS ip target group with an HTTPS health check`, () => {
      const group = resource(module, 'aws_lb_target_group', name)
      expect(unquote(attr(group.body, 'protocol'))).toBe('HTTPS')
      expect(unquote(attr(group.body, 'target_type'))).toBe('ip')
      const health = nested(group, 'health_check')[0]
      expect(health && unquote(attr(health.body, 'protocol'))).toBe('HTTPS')
    })
  }

  it('checks Keycloak readiness on its management interface, not a public path', () => {
    const health = nested(resource(module, 'aws_lb_target_group', 'keycloak'), 'health_check')[0]
    expect(health && unquote(attr(health.body, 'path'))).toBe('/health/ready')
    expect(health && attr(health.body, 'port')).toBe('var.keycloak_management_port')
  })

  it('declares only the api and keycloak target groups', () => {
    expect(resources(module, 'aws_lb_target_group').map((g) => g.labels[1])).toEqual(['api', 'keycloak'])
  })
})

describe('ALB routing follows the AD-19 table', () => {
  it('evaluates refusals before the Keycloak forward', () => {
    const priorities = resources(module, 'aws_lb_listener_rule').map((r) => ({
      priority: Number(attr(r.body, 'priority')),
      forwards: unquote(attr(nested(r, 'action')[0]?.body ?? '', 'type')) === 'forward',
    }))
    expect(priorities.some((p) => p.forwards)).toBe(true)
    expect(priorities.some((p) => !p.forwards)).toBe(true)
    const firstForward = Math.min(...priorities.filter((p) => p.forwards).map((p) => p.priority))
    const lastRefusal = Math.max(...priorities.filter((p) => !p.forwards).map((p) => p.priority))
    expect(lastRefusal).toBeLessThan(firstForward)
  })

  for (const { raw, expected } of routingCases) {
    it(`${raw} → ${expected}`, () => {
      expect(albRoute(raw.split('?')[0] ?? raw)).toBe(expected)
    })
  }
})

describe('GovCloud portability', () => {
  it('hard-codes no ARN partition and checks the certificate against the current partition', () => {
    expect(allSource).not.toMatch(/arn:aws[:-]/)
    expect(module.some((b) => b.kind === 'data' && b.labels[0] === 'aws_partition')).toBe(true)
    expect(allSource).toMatch(/arn:\$\{data\.aws_partition\.current\.partition\}:acm:/)
  })

  it('ships a terraform test that plans the module with aws-us-gov values', () => {
    const tests = join(dir, 'tests', 'edge.tftest.hcl')
    expect(existsSync(tests)).toBe(true)
    const source = readFileSync(tests, 'utf8')
    expect(source).toMatch(/mock_provider\s+"aws"/)
    expect(source).toMatch(/partition\s*=\s*"aws-us-gov"/)
    expect(source).toMatch(/\/admin\/\*/)
    expect(source).toMatch(/\/realms\/master\/\*/)
  })
})

describe('no-secret-in-iac', () => {
  it('carries no secret, private key or certificate body', () => {
    expect(allSource).not.toBe('')
    expect(allSource).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|BEGIN CERTIFICATE/)
    expect(allSource).not.toMatch(/(password|secret|token)\s*=\s*"[^"$]+"/i)
  })
})
