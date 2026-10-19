# packages/db/docker-init

Mounted into the postgres service as `/docker-entrypoint-initdb.d`. `01-roles.sql` creates
the `keycloak` database and role (CMP-6), the `sr_migrator` role that runs the committed
migrations and owns the schema, and one login role per deployable (`sr_api`,
`sr_report_worker`, `sr_mail_worker`). Table privileges are granted by the migrations
themselves (AD-10), so they are the same locally and on RDS.
