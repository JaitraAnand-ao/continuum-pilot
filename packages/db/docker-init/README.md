# packages/db/docker-init

Mounted into the postgres service as `/docker-entrypoint-initdb.d`; runs once, on an empty data
directory.

- `01-keycloak.sh` creates the `keycloak` login role and database when `KEYCLOAK_DB_PASSWORD` is set.

The application's group roles (`sr_api`, `sr_report_worker`, `sr_mail_worker`, `sr_auditor`,
all NOLOGIN) and their per-table grants (AD-10) are not created here: the committed migrations
in `../migrations` create them idempotently, so the local stack and RDS get the same grants.
