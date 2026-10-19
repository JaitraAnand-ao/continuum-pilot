/* AC-8: the report job's identity holds only these Graph application permissions, all read-only.
 * The ports it uses (IF-13, IF-14) expose reads only, so the job has no way to change the tenant. */
export const REPORT_JOB_GRAPH_PERMISSIONS = [
  'AuditLog.Read.All',
  'IdentityRiskEvent.Read.All',
  'IdentityRiskyUser.Read.All',
  'Policy.Read.All',
] as const
