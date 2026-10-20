# infra/monitoring

CMP-11 (AD-12, AD-23): the CloudWatch alarms on what the workers emit, the KMS key for the log groups this module adds, and the 400-day audit mirror.

## Alarms (ST-2)

Every alarm watches namespace `SigninReports`, the namespace `packages/report-worker` puts metrics in (IF-17). Each metric has no dimensions. Every alarm notifies the KMS-encrypted `${name_prefix}-alarms` SNS topic on ALARM and on OK.

| Alarm                                  | Metric, statistic                          | Fires when                                                                 |
| -------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `${name_prefix}-no-report-by-0730-utc` | `CompleteReportMissing`, Maximum >= 1, 1 h | The `report.check` job at 07:30 UTC found no complete report for D (AC-6)  |
| `${name_prefix}-report-check-silent`   | `CompleteReportMissing`, SampleCount < 1   | No check datapoint for 25 h, so the 07:30 check did not run (AC-6)         |
| `${name_prefix}-report-not-generated`  | `ReportNotGenerated`, Sum >= 1, 1 h        | Every Graph source still failed at 07:00 UTC, so D is not generated (AC-5) |

The first alarm treats missing data as not breaching, because the check emits only once a day. The second alarm covers the case where that single datapoint never arrives.

## Logs and the audit mirror

- `aws_kms_key.logs` is a rotating CMK with a 30-day deletion window. Its policy lets CloudWatch Logs use it only for `/${name_prefix}/*` log groups in this account and region. It also lets CloudWatch alarms publish to the encrypted topic.
- `/${name_prefix}/report-worker` is the report-worker's awslogs group. It is encrypted with that CMK.
- `/${name_prefix}/audit-mirror` keeps audit events for 400 days and is encrypted with the same CMK. Terraform's `prevent_destroy` guards it. The `${name_prefix}-audit-mirror-protect` policy is attached to every role in `protected_role_names`. It denies deleting the group or its streams, changing its retention or key, and disabling or deleting the CMK.

The module takes its partition from `aws_partition`, and service principals take their domain from it too. The provider and the S3 backend use FIPS endpoints.

## Tests

- `npx vitest run --config infra/monitoring/vitest.config.ts` runs report-worker's real check and generate code. It evaluates each alarm against the datapoints that code emits. It also checks the key policy, log-group encryption, the mirror's retention and deny, the partition and secret rules.
- `terraform test` (run in `terraform/`, Terraform >= 1.7) makes plan assertions against a mocked provider pinned to `aws-us-gov`.
