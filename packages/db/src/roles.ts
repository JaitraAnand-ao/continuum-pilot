/* AD-10: one NOLOGIN group role per deployable; each login user is a member of exactly one. */
export const DB_ROLES = {
  api: 'sr_api',
  reportWorker: 'sr_report_worker',
  mailWorker: 'sr_mail_worker',
  auditor: 'sr_auditor',
} as const

export type DbRole = (typeof DB_ROLES)[keyof typeof DB_ROLES]
