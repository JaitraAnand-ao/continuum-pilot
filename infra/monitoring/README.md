# infra/monitoring

CMP-11 (AD-12, AD-23): CloudWatch alarms, KMS-encrypted log groups and the 400-day audit mirror.
Written in Terraform's JSON syntax (`*.tf.json`) so the tests can check the configuration as data.

| File                | Holds                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| `metrics.json`      | The metric contract: namespace, names and dimensions the workers emit         |
| `alarms.tf.json`    | ST-2 AC-6 alarm "no complete report by 07:30 UTC" and its KMS-encrypted topic |
| `logs.tf.json`      | Report-worker log group and the 400-day audit mirror, both on the CMK         |
| `audit.tf.json`     | IAM deny on deleting or shortening the audit mirror and disabling its key     |
| `kms.tf.json`       | The monitoring CMK and its key policy                                         |
| `variables.tf.json` | Region (US commercial or aws-us-gov), retention, protected roles              |

Every ARN is built from `data.aws_partition.current.partition`, and the provider uses FIPS endpoints.

## The 07:30 UTC alarm

The report worker emits `SigninReports/CompleteReportLagDays` (`Service=report-worker`) once a minute:
the whole UTC days between today and the latest report published complete. The alarm's metric math
is in alarm when that lag is above 1 at or after 07:30 UTC, or when the worker emits nothing.

## Tests

```sh
npx vitest run --config infra/monitoring/vitest.config.ts
```

The tests evaluate the alarm's metric math at given instants, and assert the encryption, retention,
deny policy and partition handling of the module.
