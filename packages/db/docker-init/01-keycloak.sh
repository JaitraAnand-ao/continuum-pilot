#!/bin/sh
# Local stack only: the keycloak database beside signin_reports, owned by its own login role.
# The password comes from the environment so none is committed; without it the step is skipped.
set -eu

if [ -z "${KEYCLOAK_DB_PASSWORD:-}" ]; then
  echo "01-keycloak: KEYCLOAK_DB_PASSWORD unset, keycloak database not created"
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v password="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'password';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
