# Plan-level assertions for CMP-11, run with `terraform test` from infra/monitoring/terraform.
# The mocked provider makes this run offline and pins the partition to GovCloud, so
# the module is proven against aws-us-gov values (rubric: govcloud-portable).

mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition  = "aws-us-gov"
      dns_suffix = "amazonaws.com"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }
}

variables {
  region               = "us-gov-west-1"
  name_prefix          = "signin-reports"
  protected_role_names = ["signin-reports-operator"]
}

run "no_report_alarm_watches_the_worker_metric" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.no_report_by_0730.namespace == "SigninReports" && aws_cloudwatch_metric_alarm.no_report_by_0730.metric_name == "CompleteReportMissing"
    error_message = "The 'no report by 07:30 UTC' alarm must watch SigninReports/CompleteReportMissing, the metric report-worker emits."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.no_report_by_0730.threshold == 1 && aws_cloudwatch_metric_alarm.no_report_by_0730.comparison_operator == "GreaterThanOrEqualToThreshold"
    error_message = "The alarm must fire on CompleteReportMissing >= 1."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.report_check_silent.treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.report_check_silent.statistic == "SampleCount"
    error_message = "A check that never runs must also raise an alarm."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.report_not_generated.metric_name == "ReportNotGenerated"
    error_message = "A day recorded as not generated must raise an alarm."
  }
}

run "log_groups_use_the_cmk" {
  command = plan

  assert {
    condition     = aws_kms_key.logs.enable_key_rotation && aws_kms_key.logs.deletion_window_in_days == 30
    error_message = "The monitoring CMK must rotate and keep a 30-day deletion window."
  }

  assert {
    condition     = aws_cloudwatch_log_group.audit_mirror.retention_in_days == 400
    error_message = "The audit mirror keeps 400 days."
  }

  assert {
    condition     = strcontains(aws_iam_policy.audit_mirror_protect.policy, "logs:DeleteLogGroup") && strcontains(aws_iam_policy.audit_mirror_protect.policy, "\"Deny\"")
    error_message = "IAM must deny deleting the audit mirror."
  }

  assert {
    condition     = strcontains(aws_kms_key.logs.policy, "arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:/signin-reports/*")
    error_message = "The key policy must admit only this module's log groups, in the GovCloud partition."
  }
}

run "rejects_an_unknown_region" {
  command = plan

  variables {
    region = "gov-west"
  }

  expect_failures = [var.region]
}

run "requires_a_role_to_protect_the_mirror" {
  command = plan

  variables {
    protected_role_names = []
  }

  expect_failures = [var.protected_role_names]
}
