# Terraform-native plan test of CMP-11 against GovCloud values, offline: the AWS provider is mocked.
# Run from infra/monitoring with `terraform init -backend=false && terraform test`, or through
# test/terraform-test.test.ts, which does the same in a scratch copy of the module.

mock_provider "aws" {
  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws-us-gov:kms:us-gov-west-1:111122223333:key/0b7e6a52-6f1d-4c1e-9a43-2f4f0e8c9d11"
      key_id = "0b7e6a52-6f1d-4c1e-9a43-2f4f0e8c9d11"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  partition            = "aws-us-gov"
  region               = "us-gov-west-1"
  account_id           = "111122223333"
  protected_role_names = ["signin-reports-ci-deployer", "signin-reports-operator"]
}

run "plan_succeeds_with_govcloud_values" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.no_report_by_0730_utc.namespace == "SigninReports/ReportWorker"
    error_message = "no_report_by_0730_utc must watch the SigninReports/ReportWorker namespace."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.no_report_by_0730_utc.metric_name == "CompleteReportAvailable"
    error_message = "no_report_by_0730_utc must watch CompleteReportAvailable."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.report_deadline_check_missing.namespace == "SigninReports/ReportWorker"
    error_message = "report_deadline_check_missing must watch the SigninReports/ReportWorker namespace."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.report_deadline_check_missing.metric_name == "CompleteReportAvailable"
    error_message = "report_deadline_check_missing must watch CompleteReportAvailable."
  }

  assert {
    condition     = length(aws_iam_role_policy_attachment.audit_mirror_deny_delete) == 2
    error_message = "The audit mirror deny must attach to every protected role."
  }
}

# Computed attributes such as the key ARN only take their mocked values on apply; with the provider
# mocked, apply creates nothing.
run "both_log_groups_carry_the_key_arn" {
  command = apply

  assert {
    condition     = aws_cloudwatch_log_group.report_worker.kms_key_id == aws_kms_key.monitoring.arn
    error_message = "The report-worker log group must be encrypted with the monitoring key."
  }

  assert {
    condition     = aws_cloudwatch_log_group.audit_mirror.kms_key_id == aws_kms_key.monitoring.arn
    error_message = "The audit mirror log group must be encrypted with the monitoring key."
  }

  assert {
    condition     = startswith(aws_kms_key.monitoring.arn, "arn:aws-us-gov:kms:us-gov-west-1:")
    error_message = "The key ARN must be the GovCloud key."
  }
}

run "protected_role_names_must_not_be_empty" {
  command = plan

  variables {
    protected_role_names = []
  }

  expect_failures = [var.protected_role_names]
}
