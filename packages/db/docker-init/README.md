# packages/db/docker-init

Mounted into the postgres service as `/docker-entrypoint-initdb.d` and run once, on an
empty data directory.

- `10-keycloak.sh` creates the `keycloak` login role and the `keycloak` database it owns.
  Its password is `KEYCLOAK_DB_PASSWORD`, falling back to the local `POSTGRES_PASSWORD`.

The application's runtime roles (`sr_api`, `sr_report_worker`, `sr_mail_worker`) and their
per-table grants (AD-10) are created by the committed migrations in `../migrations`, so the
same grants apply locally and on RDS.
