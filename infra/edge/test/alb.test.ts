/* CMP-10 / AD-19: the production edge. Reads the Terraform in ../terraform and checks
 * the listener, its rules and the target groups, then replays the shared routing table
 * through a model of ALB rule evaluation (priority order, first match, case-sensitive
 * path patterns with * and ?). */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attr, blocks, readModule, resource, resources, stringList, unquote, type Block } from './hcl'
import { find, parse, servers } from './nginx'
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

/** Every character ALB accepts in a path-pattern value. */
const albPathCharacters = /^[A-Za-z0-9_\-.$/~"'@:+&*?]+$/

function pathPatterns(rule: Block): string[] {
  return nested(rule, 'condition').flatMap((c) =>
    nested(c, 'path_pattern').flatMap((p) => stringList(attr(p.body, 'values'))),
  )
}

/** The URI-path regexes of the blocking rules in web ACLs associated with the edge ALB. */
function wafBlockRegexes(): RegExp[] {
  const associated = new Set(
    resources(module, 'aws_wafv2_web_acl_association')
      .filter((a) => attr(a.body, 'resource_arn') === 'aws_lb.edge.arn')
      .map((a) => attr(a.body, 'web_acl_arn')),
  )
  return resources(module, 'aws_wafv2_web_acl')
    .filter((acl) => associated.has(`aws_wafv2_web_acl.${acl.labels[1]}.arn`))
    .flatMap((acl) => nested(acl, 'rule'))
    .filter((rule) => nested(nested(rule, 'action')[0] ?? rule, 'block').length > 0)
    .flatMap((rule) => [...rule.body.matchAll(/regex_string\s*=\s*"([^"]*)"/g)].map((m) => new RegExp(m[1] ?? '')))
}

function nginxHsts(): string | undefined {
  const config = parse(readFileSync(join(import.meta.dirname, '..', 'nginx', 'default.conf'), 'utf8'))
  return servers(config)
    .flatMap((s) => find(s.children ?? [], 'add_header'))
    .find((h) => h.args[0] === 'Strict-Transport-Security')?.args[1]
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
  if (wafBlockRegexes().some((r) => r.test(path))) return 'denied'
  const rules = resources(module, 'aws_lb_listener_rule')
    .map((rule) => ({ rule, priority: Number(attr(rule.body, 'priority')) }))
    .sort((a, b) => a.priority - b.priority)
  for (const { rule } of rules) {
    const patterns = pathPatterns(rule)
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

  it('sends the same HSTS header as the local edge nginx', () => {
    const https = resource(module, 'aws_lb_listener', 'https')
    const hsts = unquote(attr(https.body, 'routing_http_response_strict_transport_security_header_value'))
    expect(hsts).toMatch(/max-age=\d{8,}/)
    expect(hsts).toBe(nginxHsts())
    // The listener header arguments arrived in 5.84.0 and apply to existing listeners from 5.89.0.
    const floor = /hashicorp\/aws"[\s\S]*?version\s*=\s*">=\s*(\d+)\.(\d+)/.exec(allSource)
    expect(Number(floor?.[1]) * 1000 + Number(floor?.[2])).toBeGreaterThanOrEqual(5089)
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

describe('percent-encoded Keycloak paths are refused by WAF (ALB path patterns cannot hold %)', () => {
  it('uses only ALB-permitted characters in every path-pattern value', () => {
    const values = resources(module, 'aws_lb_listener_rule').flatMap(pathPatterns)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(value).toMatch(albPathCharacters)
  })

  it('associates a regional web ACL with the edge ALB that allows by default', () => {
    const association = resources(module, 'aws_wafv2_web_acl_association')
    expect(association.map((a) => attr(a.body, 'resource_arn'))).toEqual(['aws_lb.edge.arn'])
    const acl = resource(module, 'aws_wafv2_web_acl', 'edge')
    expect(attr(association[0]?.body ?? '', 'web_acl_arn')).toBe('aws_wafv2_web_acl.edge.arn')
    expect(unquote(attr(acl.body, 'scope'))).toBe('REGIONAL')
    expect(nested(nested(acl, 'default_action')[0] ?? acl, 'allow')).toHaveLength(1)
  })

  it('blocks on the raw URI path, with no decoding transformation', () => {
    const rules = nested(resource(module, 'aws_wafv2_web_acl', 'edge'), 'rule')
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.body).toMatch(/uri_path\s*\{\s*\}/)
      const types = [...rule.body.matchAll(/text_transformation\s*\{[^}]*type\s*=\s*"([^"]*)"/g)].map((m) => m[1])
      expect(types).toEqual(['NONE'])
    }
  })

  it.each([
    ['/realms/signin-reports/%2e%2e/master/', true],
    ['/resources/x1y2z/%61dmin/keycloak.v2/main.js', true],
    ['/realms/signin-reports/protocol/openid-connect/auth', false],
    ['/resources/x1y2z/login/keycloak.v2/css/styles.css', false],
    ['/api/reports/100%25', false],
  ])('%s blocked by WAF: %s', (path, blocked) => {
    const regexes = wafBlockRegexes()
    expect(regexes.length).toBeGreaterThan(0)
    expect(regexes.some((r) => r.test(path))).toBe(blocked)
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
