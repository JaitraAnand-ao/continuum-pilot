import { describe, expect, it } from 'vitest'
import { block, list, loadModule, policyDocument, resources, statements, type Json } from './lib/module.js'

const mod = loadModule()
const KEY = '${aws_kms_key.logs.arn}'
const PARTITION = '${data.aws_partition.current.partition}'
const ACCOUNT = '${data.aws_caller_identity.current.account_id}'

describe('the monitoring KMS customer managed key', () => {
  const key = resources(mod, 'aws_kms_key').logs as Json
  const policy = policyDocument(key.policy)

  it('rotates and cannot be deleted at short notice', () => {
    expect(key.enable_key_rotation).toBe(true)
    expect(key.deletion_window_in_days).toBe(30)
    expect(key.is_enabled ?? true).toBe(true)
  })

  it('lets CloudWatch Logs use it only for this module’s log groups in this account and region', () => {
    const logs = statements(policy).find(
      (s) =>
        (s.Principal as Json | undefined)?.Service === 'logs.${var.region}.${data.aws_partition.current.dns_suffix}',
    )
    expect(logs).toBeDefined()
    expect(logs!.Effect).toBe('Allow')
    expect(list(logs!.Action)).not.toContain('kms:*')
    expect(list(logs!.Action)).toEqual(expect.arrayContaining(['kms:Encrypt*', 'kms:Decrypt*', 'kms:GenerateDataKey*']))
    const condition = (logs!.Condition as Json).ArnLike as Json
    expect(condition['kms:EncryptionContext:aws:logs:arn']).toBe(
      `arn:${PARTITION}:logs:\${var.region}:${ACCOUNT}:log-group:/\${var.name_prefix}/*`,
    )
  })

  it('lets CloudWatch alarms publish to the encrypted topic and nothing more', () => {
    const cw = statements(policy).find(
      (s) => (s.Principal as Json | undefined)?.Service === 'cloudwatch.${data.aws_partition.current.dns_suffix}',
    )
    expect(cw).toBeDefined()
    expect(list(cw!.Action).sort()).toEqual(['kms:Decrypt', 'kms:GenerateDataKey*'])
  })

  it('keeps key administration with the account root of this partition', () => {
    const root = statements(policy).find((s) => (s.Principal as Json | undefined)?.AWS !== undefined)
    expect((root!.Principal as Json).AWS).toBe(`arn:${PARTITION}:iam::${ACCOUNT}:root`)
  })
})

describe('every log group the part adds is KMS-encrypted', () => {
  const groups = resources(mod, 'aws_cloudwatch_log_group')

  it('adds the report-worker log group and the audit mirror', () => {
    expect(Object.keys(groups).sort()).toEqual(['audit_mirror', 'report_worker'])
    expect(groups.report_worker!.name).toBe('/${var.name_prefix}/report-worker')
    expect(groups.audit_mirror!.name).toBe('/${var.name_prefix}/audit-mirror')
  })

  it('encrypts each one with the customer managed key', () => {
    for (const [name, group] of Object.entries(groups)) expect(group.kms_key_id, name).toBe(KEY)
  })

  it('names every group under the prefix the key policy admits', () => {
    for (const [name, group] of Object.entries(groups))
      expect(String(group.name), name).toMatch(/^\/\$\{var\.name_prefix\}\//)
  })
})

describe('the 400-day audit mirror (AD-23)', () => {
  const mirror = resources(mod, 'aws_cloudwatch_log_group').audit_mirror as Json
  const ARN = '${aws_cloudwatch_log_group.audit_mirror.arn}'

  it('keeps events for exactly 400 days and refuses to be destroyed by Terraform', () => {
    expect(mirror.retention_in_days).toBe(400)
    expect(block(mirror.lifecycle).prevent_destroy).toBe(true)
  })

  it('has an IAM policy denying deletion, retention changes and key removal', () => {
    const policy = policyDocument(resources(mod, 'aws_iam_policy').audit_mirror_protect!.policy)
    const deny = statements(policy).filter((s) => s.Effect === 'Deny')
    const logsDeny = deny.find((s) => list(s.Resource).includes(ARN))
    expect(logsDeny).toBeDefined()
    expect(list(logsDeny!.Action)).toEqual(
      expect.arrayContaining([
        'logs:DeleteLogGroup',
        'logs:DeleteLogStream',
        'logs:PutRetentionPolicy',
        'logs:DeleteRetentionPolicy',
        'logs:DisassociateKmsKey',
        'logs:AssociateKmsKey',
      ]),
    )
    expect(list(logsDeny!.Resource)).toEqual(expect.arrayContaining([ARN, `${ARN}:*`]))
    const keyDeny = deny.find((s) => list(s.Resource).includes(KEY))
    expect(list(keyDeny!.Action)).toEqual(expect.arrayContaining(['kms:ScheduleKeyDeletion', 'kms:DisableKey']))
  })

  it('attaches that deny to every operator role it is given, and requires at least one', () => {
    const attach = resources(mod, 'aws_iam_role_policy_attachment').audit_mirror_protect as Json
    expect(attach.for_each).toBe('${toset(var.protected_role_names)}')
    expect(attach.role).toBe('${each.value}')
    expect(attach.policy_arn).toBe('${aws_iam_policy.audit_mirror_protect.arn}')
    const variable = (mod.variable as Record<string, Json>).protected_role_names!
    expect(String(block(variable.validation).condition)).toContain('length(var.protected_role_names) > 0')
  })
})
