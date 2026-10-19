import { describe, expect, it } from 'vitest'
import { loadModule, resource, resources, strings } from './support/terraform'

/* @story:ST-2 — the report worker's logs and the audit mirror are KMS-encrypted, and the mirror keeps 400 days. */

const mod = loadModule()

describe('KMS-encrypted log groups', () => {
  const groups = resources(mod, 'aws_cloudwatch_log_group')

  it('adds a log group for the report worker', () => {
    expect(resource(mod, 'aws_cloudwatch_log_group', 'report_worker').name).toBe('/signin-reports/report-worker')
  })

  it('encrypts every log group it adds with the monitoring customer-managed key', () => {
    expect(Object.keys(groups).length).toBeGreaterThan(0)
    for (const group of Object.values(groups)) {
      expect(group.kms_key_id).toBe('${aws_kms_key.monitoring.arn}')
    }
  })

  it('rotates the customer-managed key and lets only this account and CloudWatch use it', () => {
    const key = resource(mod, 'aws_kms_key', 'monitoring')
    expect(key.enable_key_rotation).toBe(true)
    expect(key.policy).toBe('${data.aws_iam_policy_document.monitoring_key.json}')
    const statements = mod.data.aws_iam_policy_document?.monitoring_key?.statement as {
      principals: { type: string; identifiers: string[] }[]
      condition?: { test: string; variable: string; values: string[] }[]
      actions: string[]
    }[]
    const services = statements.flatMap((s) =>
      s.principals.filter((p) => p.type === 'Service').flatMap((p) => p.identifiers),
    )
    expect(services.sort()).toEqual(['cloudwatch.amazonaws.com', 'logs.${data.aws_region.current.name}.amazonaws.com'])
    const logs = statements.find((s) => strings(s.principals).some((p) => p.startsWith('logs.')))
    expect(logs?.condition).toEqual([
      {
        test: 'ArnLike',
        variable: 'kms:EncryptionContext:aws:logs:arn',
        values: [
          'arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/signin-reports/*',
        ],
      },
    ])
  })
})

describe('the 400-day audit mirror', () => {
  const mirror = resource(mod, 'aws_cloudwatch_log_group', 'audit_mirror')

  it('keeps 400 days and cannot be destroyed by Terraform', () => {
    expect(mirror.name).toBe('/signin-reports/audit-mirror')
    expect(mirror.retention_in_days).toBe(400)
    expect(mirror.lifecycle).toEqual({ prevent_destroy: true })
  })

  it('denies deleting the mirror, shortening its retention or disabling its key', () => {
    const policy = resource(mod, 'aws_iam_policy', 'audit_mirror_protection')
    expect(policy.policy).toBe('${data.aws_iam_policy_document.audit_mirror_protection.json}')
    const statements = mod.data.aws_iam_policy_document?.audit_mirror_protection?.statement as {
      effect: string
      actions: string[]
      resources: string[]
    }[]
    expect(statements.every((s) => s.effect === 'Deny')).toBe(true)
    const logs = statements.find((s) => s.actions.includes('logs:DeleteLogGroup'))
    expect(logs?.actions).toEqual(
      expect.arrayContaining([
        'logs:DeleteLogGroup',
        'logs:DeleteLogStream',
        'logs:DeleteRetentionPolicy',
        'logs:PutRetentionPolicy',
        'logs:DisassociateKmsKey',
      ]),
    )
    expect(logs?.resources).toEqual([
      '${aws_cloudwatch_log_group.audit_mirror.arn}',
      '${aws_cloudwatch_log_group.audit_mirror.arn}:*',
    ])
    const kms = statements.find((s) => s.actions.includes('kms:ScheduleKeyDeletion'))
    expect(kms?.actions).toEqual(expect.arrayContaining(['kms:ScheduleKeyDeletion', 'kms:DisableKey']))
    expect(kms?.resources).toEqual(['${aws_kms_key.monitoring.arn}'])
  })

  it('attaches the deny to every protected role', () => {
    const attachment = resource(mod, 'aws_iam_role_policy_attachment', 'audit_mirror_protection')
    expect(attachment.for_each).toBe('${toset(var.audit_mirror_protected_role_names)}')
    expect(attachment.role).toBe('${each.value}')
    expect(attachment.policy_arn).toBe('${aws_iam_policy.audit_mirror_protection.arn}')
  })
})
