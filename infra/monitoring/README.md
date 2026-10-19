# infra/monitoring

CMP-11 (AD-12, AD-23). Terraform root module in Terraform's JSON syntax (`*.tf.json`), so the plan
assertions in `test/` read it without an HCL parser.

- `kms.tf.json` — the rotating customer-managed key for every log group, the audit mirror and the alarm topic.
- `log-groups.tf.json` — `/signin-reports/report-worker` and the 400-day `/signin-reports/audit-mirror`.
- `audit-mirror.tf.json` — IAM deny on deleting the mirror, shortening its retention or destroying its key,
  attached to every role in `protected_role_names`.
- `alarms.tf.json` — ST-2 AC-6: `no-report-by-0730-utc`, and `report-deadline-check-missing` for when the
  check itself stops running.
- `report-worker-metrics.json` — the metric contract the report-worker emits and the alarms watch:
  `SigninReports/ReportWorker` `CompleteReportAvailable`, 1 or 0, from the `report.deadline-check` job at 07:30 UTC.

Every ARN is built from `var.partition` (`aws` or `aws-us-gov`) and the provider uses FIPS endpoints.

Run the assertions with `npx vitest run --config infra/monitoring/vitest.config.ts`.
