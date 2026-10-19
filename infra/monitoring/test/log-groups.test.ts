import { describe, expect, it } from 'vitest'
import { loadModule, policyDocument, resource, resources } from './terraform'

const module = loadModule()

describe('CMP-11 log groups for the daily report run (ST-2)', () => {
  it('declares the report worker log group and the audit mirror', () => {
    expect(resource(module, 'aws_cloudwatch_log_group', 'report_worker')['name']).toBe(
      '/${var.name_prefix}/report-worker',
    )
    expect(resource(module, 'aws_cloudwatch_log_group', 'audit_mirror')['name']).toBe(
      '/${var.name_prefix}/audit-mirror',
    )
  })

  it('encrypts every log group it adds with the customer-managed KMS key', () => {
    const groups = Object.values(resources(module, 'aws_cloudwatch_log_group'))
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) expect(group['kms_key_id']).toBe('${aws_kms_key.monitoring.arn}')
  })

  it('uses a rotating customer-managed key that CloudWatch Logs may use only for this account’s log groups', () => {
    const key = resource(module, 'aws_kms_key', 'monitoring')
    expect(key['enable_key_rotation']).toBe(true)
    expect(key['deletion_window_in_days']).toBe(30)
    expect(key['policy']).toBe('${data.aws_iam_policy_document.monitoring_key.json}')

    const logs = policyDocument(module, 'monitoring_key').find((s) => s['sid'] === 'CloudWatchLogsUse')
    expect(logs?.['principals']).toEqual([{ type: 'Service', identifiers: ['logs.${var.region}.amazonaws.com'] }])
    expect(logs?.['condition']).toEqual([
      {
        test: 'ArnLike',
        variable: 'kms:EncryptionContext:aws:logs:arn',
        values: ['arn:${var.partition}:logs:${var.region}:${var.account_id}:log-group:*'],
      },
    ])
  })

  it('lets CloudWatch alarms publish to the encrypted alarm topic', () => {
    const alarms = policyDocument(module, 'monitoring_key').find((s) => s['sid'] === 'CloudWatchAlarmsPublish')
    expect(alarms?.['principals']).toEqual([{ type: 'Service', identifiers: ['cloudwatch.amazonaws.com'] }])
    expect(alarms?.['actions']).toEqual(['kms:Decrypt', 'kms:GenerateDataKey*'])
  })

  it('lets CloudWatch alarms use the key only on behalf of this account', () => {
    const alarms = policyDocument(module, 'monitoring_key').find((s) => s['sid'] === 'CloudWatchAlarmsPublish')
    expect(alarms?.['condition']).toEqual([
      { test: 'StringEquals', variable: 'aws:SourceAccount', values: ['${var.account_id}'] },
    ])
  })
})

describe('CMP-11 audit mirror (AD-23)', () => {
  const mirror = resource(module, 'aws_cloudwatch_log_group', 'audit_mirror')
  const deny = policyDocument(module, 'audit_mirror_deny_delete')

  it('keeps 400 days and cannot be destroyed by Terraform', () => {
    expect(mirror['retention_in_days']).toBe(400)
    expect(mirror['lifecycle']).toEqual([{ prevent_destroy: true }])
  })

  it('denies deleting the mirror, its streams, or shortening its retention', () => {
    const statement = deny.find((s) => s['sid'] === 'DenyAuditMirrorDeletion')
    expect(statement?.['effect']).toBe('Deny')
    expect(statement?.['actions']).toEqual(
      expect.arrayContaining([
        'logs:DeleteLogGroup',
        'logs:DeleteLogStream',
        'logs:DeleteRetentionPolicy',
        'logs:PutRetentionPolicy',
        'logs:DisassociateKmsKey',
      ]),
    )
    expect(statement?.['resources']).toEqual([
      'arn:${var.partition}:logs:${var.region}:${var.account_id}:log-group:/${var.name_prefix}/audit-mirror',
      'arn:${var.partition}:logs:${var.region}:${var.account_id}:log-group:/${var.name_prefix}/audit-mirror:*',
    ])
  })

  it('denies destroying the key that makes the mirror readable', () => {
    const statement = deny.find((s) => s['sid'] === 'DenyAuditMirrorKeyDestruction')
    expect(statement?.['effect']).toBe('Deny')
    expect(statement?.['actions']).toEqual(
      expect.arrayContaining(['kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy']),
    )
    expect(statement?.['resources']).toEqual(['${aws_kms_key.monitoring.arn}'])
  })

  it('attaches the deny to every protected role', () => {
    const policy = resource(module, 'aws_iam_policy', 'audit_mirror_deny_delete')
    expect(policy['policy']).toBe('${data.aws_iam_policy_document.audit_mirror_deny_delete.json}')
    const attachment = resource(module, 'aws_iam_role_policy_attachment', 'audit_mirror_deny_delete')
    expect(attachment['for_each']).toBe('${toset(var.protected_role_names)}')
    expect(attachment['role']).toBe('${each.value}')
    expect(attachment['policy_arn']).toBe('${aws_iam_policy.audit_mirror_deny_delete.arn}')
  })

  it('requires at least one protected role, so the deny can never silently attach to nobody', () => {
    const roles = module.variable['protected_role_names']
    expect(roles?.['type']).toBe('list(string)')
    expect(roles).not.toHaveProperty('default')
    expect(roles?.['validation']).toEqual([
      {
        condition: '${length(var.protected_role_names) > 0}',
        error_message: expect.stringMatching(/protected_role_names/),
      },
    ])
  })
})
