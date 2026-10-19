import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadModule, moduleDir } from './terraform'

const module = loadModule()
const tftest = readFileSync(join(moduleDir, 'tests', 'monitoring.tftest.hcl'), 'utf8')
const hasTerraform = spawnSync('terraform', ['version'], { encoding: 'utf8' }).status === 0

describe('CMP-11 Terraform-native plan test (tests/monitoring.tftest.hcl)', () => {
  it('plans GovCloud values offline, asserts each alarm and log group, and relies on the module rejecting no protected roles', () => {
    expect(tftest).toMatch(/^mock_provider "aws" \{/m)
    expect(tftest).toMatch(/^\s*partition\s+= "aws-us-gov"$/m)
    expect(tftest).toMatch(/^\s*region\s+= "us-gov-west-1"$/m)
    expect(tftest).toMatch(/^\s*protected_role_names = \["[^"]+"(, "[^"]+")*\]$/m)
    for (const alarm of ['no_report_by_0730_utc', 'report_deadline_check_missing']) {
      expect(tftest).toContain(`aws_cloudwatch_metric_alarm.${alarm}.namespace == "SigninReports/ReportWorker"`)
      expect(tftest).toContain(`aws_cloudwatch_metric_alarm.${alarm}.metric_name == "CompleteReportAvailable"`)
    }
    for (const group of ['report_worker', 'audit_mirror']) {
      expect(tftest).toContain(`aws_cloudwatch_log_group.${group}.kms_key_id == aws_kms_key.monitoring.arn`)
    }
    expect(tftest).toMatch(/protected_role_names = \[\]\s*\}\s*expect_failures = \[var\.protected_role_names\]/)
    expect(JSON.stringify(module.variable['protected_role_names']?.['validation'])).toContain(
      'length(var.protected_role_names) > 0',
    )
  })

  it.skipIf(!hasTerraform)(
    'passes terraform validate and terraform test',
    () => {
      const scratch = mkdtempSync(join(tmpdir(), 'cmp-11-'))
      try {
        for (const file of readdirSync(moduleDir).filter((name) => name.endsWith('.tf.json'))) {
          cpSync(join(moduleDir, file), join(scratch, file))
        }
        cpSync(join(moduleDir, 'tests'), join(scratch, 'tests'), { recursive: true })
        for (const args of [['init', '-backend=false', '-input=false'], ['validate'], ['test']]) {
          const run = spawnSync('terraform', args, { cwd: scratch, encoding: 'utf8' })
          expect(run.status, `terraform ${args.join(' ')}\n${run.stdout}\n${run.stderr}`).toBe(0)
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
    300_000,
  )
})
