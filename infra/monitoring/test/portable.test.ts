import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { block, loadModule, TERRAFORM_DIR } from './lib/module.js'

const mod = loadModule()
const rawSources = readdirSync(TERRAFORM_DIR)
  .filter((f) => f.endsWith('.tf.json') || f.endsWith('.tf') || f.endsWith('.tfvars'))
  .map((f) => ({ file: f, text: readFileSync(join(TERRAFORM_DIR, f), 'utf8') }))

describe('GovCloud portable', () => {
  it('uses FIPS endpoints for the provider and the state backend', () => {
    const provider = block((mod.provider as Record<string, unknown>).aws)
    expect(provider.use_fips_endpoint).toBe(true)
    expect(provider.region).toBe('${var.region}')
    const backend = block(block((mod.terraform as Record<string, unknown>).backend).s3)
    expect(backend.use_fips_endpoint).toBe(true)
    expect(backend.encrypt).toBe(true)
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

  it('hard-codes no service domain: principals take their suffix from aws_partition', () => {
    expect(rawSources.length).toBeGreaterThan(0)
    for (const { file, text } of rawSources) expect(text, file).not.toMatch(/amazonaws\.com/)
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
