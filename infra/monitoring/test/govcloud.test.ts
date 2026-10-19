import { describe, expect, it } from 'vitest'
import { loadModule, strings } from './support/terraform'

/* @story:ST-2 — the monitoring module deploys unchanged to aws-us-gov. */

const mod = loadModule()

describe('GovCloud portability', () => {
  it('builds every ARN from the partition data source', () => {
    const arns = strings({ resource: mod.resource, data: mod.data }).filter((s) => s.startsWith('arn:'))
    expect(arns.length).toBeGreaterThan(0)
    for (const arn of arns) expect(arn).toMatch(/^arn:\$\{data\.aws_partition\.current\.partition\}:/)
    expect(mod.raw).not.toMatch(/arn:aws(-us-gov)?:/)
  })

  it('uses FIPS endpoints', () => {
    expect(mod.provider.aws).toMatchObject({ region: '${var.region}', use_fips_endpoint: true })
  })

  it('accepts aws-us-gov regions and rejects others', () => {
    const validation = (mod.variable.region?.validation as { condition: string }[])[0]
    const pattern = /can\(regex\("(.+)", var\.region\)\)/.exec(validation?.condition ?? '')?.[1]
    expect(pattern).toBeDefined()
    const re = new RegExp(pattern as string)
    expect(re.test('us-gov-west-1')).toBe(true)
    expect(re.test('us-gov-east-1')).toBe(true)
    expect(re.test('us-east-1')).toBe(true)
    expect(re.test('eu-west-1')).toBe(false)
  })
})
