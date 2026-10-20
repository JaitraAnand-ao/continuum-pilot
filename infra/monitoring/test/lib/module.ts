/* Reads the monitoring root module as written in terraform/*.tf.json, and evaluates a
 * CloudWatch metric alarm against datapoints the way CloudWatch does for one evaluation
 * window: aggregate by the alarm's statistic, compare with its threshold, and apply
 * treat_missing_data when the window holds no datapoint. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Json = Record<string, unknown>
export const TERRAFORM_DIR = new URL('../../terraform/', import.meta.url).pathname

/** Merge every *.tf.json in the module the way Terraform does: one namespace per block type. */
export function loadModule(dir = TERRAFORM_DIR): Json {
  const merged: Record<string, Record<string, unknown>> = {}
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.tf.json'))) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Json
    for (const [kind, body] of Object.entries(doc)) {
      if (kind === '//') continue
      merged[kind] ??= {}
      for (const [name, value] of Object.entries(body as Json)) {
        if (kind !== 'terraform' && kind !== 'provider' && name in merged[kind]!) {
          throw new Error(`${kind}.${name} is declared twice`)
        }
        const existing = merged[kind]![name]
        if (kind === 'resource' || kind === 'data') {
          merged[kind]![name] = { ...(existing as Json), ...(value as Json) }
        } else {
          merged[kind]![name] = value
        }
      }
    }
  }
  return merged
}

export function resources(mod: Json, type: string): Record<string, Json> {
  return ((mod.resource as Json | undefined)?.[type] ?? {}) as Record<string, Json>
}

/** Terraform JSON lets a nested block be one object or a list of them. */
export function blocks(value: unknown): Json[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]) as Json[]
}

export function block(value: unknown): Json {
  const list = blocks(value)
  if (list.length !== 1) throw new Error(`expected exactly one block, got ${list.length}`)
  return list[0]!
}

/** Parse a jsonencode({...}) policy written as a Terraform JSON string: `${jsonencode(...)}` holding plain JSON. */
export function policyDocument(value: unknown): Json {
  const text = String(value)
  const inner = /^\$\{jsonencode\(([\s\S]*)\)\}$/.exec(text)?.[1]
  if (inner === undefined) throw new Error(`not a jsonencode policy: ${text.slice(0, 40)}`)
  return JSON.parse(inner) as Json
}

export function statements(policy: Json): Json[] {
  return blocks(policy.Statement)
}

export function list(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(String)
}

export interface Datapoint {
  timestamp: string
  value: number
}

export type AlarmState = 'ALARM' | 'OK' | 'INSUFFICIENT_DATA'

const COMPARE: Record<string, (v: number, t: number) => boolean> = {
  GreaterThanOrEqualToThreshold: (v, t) => v >= t,
  GreaterThanThreshold: (v, t) => v > t,
  LessThanThreshold: (v, t) => v < t,
  LessThanOrEqualToThreshold: (v, t) => v <= t,
}

function aggregate(statistic: string, values: number[]): number {
  if (statistic === 'Maximum') return Math.max(...values)
  if (statistic === 'Minimum') return Math.min(...values)
  if (statistic === 'Sum') return values.reduce((a, b) => a + b, 0)
  if (statistic === 'SampleCount') return values.length
  throw new Error(`unsupported statistic ${statistic}`)
}

/** The alarm's state at `at`, judged on the datapoints in the trailing evaluation_periods x period window. */
export function evaluateAlarm(alarm: Json, datapoints: readonly Datapoint[], at: string): AlarmState {
  const period = Number(alarm.period) * 1000
  const periods = Number(alarm.evaluation_periods)
  const toAlarm = Number(alarm.datapoints_to_alarm ?? periods)
  const end = Date.parse(at)
  const compare = COMPARE[String(alarm.comparison_operator)]
  if (!compare) throw new Error(`unsupported comparison ${String(alarm.comparison_operator)}`)
  let breaching = 0
  let missing = 0
  for (let i = 0; i < periods; i++) {
    const hi = end - i * period
    const lo = hi - period
    const inPeriod = datapoints.filter((d) => Date.parse(d.timestamp) > lo && Date.parse(d.timestamp) <= hi)
    if (inPeriod.length === 0) {
      if (alarm.treat_missing_data === 'breaching') breaching++
      else missing++
      continue
    }
    if (
      compare(
        aggregate(
          String(alarm.statistic),
          inPeriod.map((d) => d.value),
        ),
        Number(alarm.threshold),
      )
    )
      breaching++
  }
  if (breaching >= toAlarm) return 'ALARM'
  if (missing === periods && alarm.treat_missing_data !== 'notBreaching') return 'INSUFFICIENT_DATA'
  return 'OK'
}
