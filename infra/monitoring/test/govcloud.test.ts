import { describe, expect, it } from 'vitest'
import { loadModule } from './terraform'

const module = loadModule()

describe('CMP-11 is portable to GovCloud', () => {
  it('validates the partition variable against the commercial and GovCloud partitions', () => {
    const partition = module.variable['partition']
    expect(partition?.['type']).toBe('string')
    expect(JSON.stringify(partition?.['validation'])).toContain('aws-us-gov')
  })

  it('builds every ARN from the partition variable', () => {
    const arns = Object.values(module.files).flatMap((text) => text.match(/arn:[^"\s]*/g) ?? [])
    expect(arns.length).toBeGreaterThan(0)
    for (const arn of arns) expect(arn).toMatch(/^arn:\$\{var\.partition\}:/)
  })

  it('reaches AWS only through FIPS endpoints', () => {
    expect(module.provider['aws']?.['use_fips_endpoint']).toBe(true)
    expect(module.provider['aws']?.['region']).toBe('${var.region}')
  })
})
