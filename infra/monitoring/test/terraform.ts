import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* The module is written in Terraform's JSON syntax so these plan assertions read it without an HCL parser. */
export const moduleDir = join(dirname(fileURLToPath(import.meta.url)), '..')

type Block = Record<string, unknown>
type Blocks = Record<string, Record<string, Block>>

export interface TerraformModule {
  files: Record<string, string>
  terraform: Block[]
  provider: Record<string, Block>
  variable: Record<string, Block>
  locals: Block
  resource: Blocks
  data: Blocks
  output: Record<string, Block>
}

export function loadModule(): TerraformModule {
  const module: TerraformModule = {
    files: {},
    terraform: [],
    provider: {},
    variable: {},
    locals: {},
    resource: {},
    data: {},
    output: {},
  }
  for (const file of readdirSync(moduleDir).filter((name) => name.endsWith('.tf.json'))) {
    const text = readFileSync(join(moduleDir, file), 'utf8')
    module.files[file] = text
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (parsed.terraform) module.terraform.push(parsed.terraform as Block)
    Object.assign(module.provider, parsed.provider)
    Object.assign(module.variable, parsed.variable)
    Object.assign(module.locals, parsed.locals)
    Object.assign(module.output, parsed.output)
    for (const kind of ['resource', 'data'] as const) {
      for (const [type, byName] of Object.entries((parsed[kind] ?? {}) as Blocks)) {
        module[kind][type] = { ...module[kind][type], ...byName }
      }
    }
  }
  return module
}

export function resources(module: TerraformModule, type: string): Record<string, Block> {
  return module.resource[type] ?? {}
}

export function resource(module: TerraformModule, type: string, name: string): Block {
  const block = resources(module, type)[name]
  if (!block) throw new Error(`${type}.${name} is not declared`)
  return block
}

export function policyDocument(module: TerraformModule, name: string): Block[] {
  const document = module.data['aws_iam_policy_document']?.[name]
  if (!document) throw new Error(`data.aws_iam_policy_document.${name} is not declared`)
  return document['statement'] as Block[]
}

export interface MetricContract {
  namespace: string
  metrics: {
    name: string
    unit: string
    statistic: string
    emittedBy: string
    scheduleCron: string
    timezone: string
    values: Record<string, string>
  }[]
}

export function loadMetricContract(): MetricContract {
  return JSON.parse(readFileSync(join(moduleDir, 'report-worker-metrics.json'), 'utf8')) as MetricContract
}
