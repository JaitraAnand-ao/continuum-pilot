# packages/db/docker-init

Mounted into the postgres service as `/docker-entrypoint-initdb.d`, run once on an empty data
directory, in name order:

- `01-roles.sql` — the per-deployable group roles `sr_api`, `sr_report_worker`, `sr_mail_worker`
  and `keycloak` (AD-10). They are created `NOLOGIN` without passwords; LOGIN and the password
  are granted from outside the repository (Secrets Manager in AWS, a local operator otherwise).
- `02-keycloak-database.sql` — the `keycloak` database, owned by the `keycloak` role.

The table grants live in the committed migrations (`../migrations`), which the migrate service
applies as the database owner.
