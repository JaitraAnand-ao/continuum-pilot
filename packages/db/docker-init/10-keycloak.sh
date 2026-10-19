#!/bin/sh
# Local Compose only (the postgres service runs this once, on an empty data directory):
# creates the keycloak login role and its own database, owned by it, so Keycloak never
# shares a database or a role with the application. The password comes from the
# environment — KEYCLOAK_DB_PASSWORD, or the local POSTGRES_PASSWORD when unset — and is
# never committed. The application's runtime roles (sr_api, sr_report_worker,
# sr_mail_worker) are created and granted by the committed migrations, not here.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v keycloak_password="${KEYCLOAK_DB_PASSWORD:-$POSTGRES_PASSWORD}" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_password';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
