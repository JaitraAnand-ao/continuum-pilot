#!/usr/bin/env bash
# Local stack only (AD-19): runs once, as the postgres superuser, when the postgres volume is first created.
# Creates the keycloak database and its owner, the application group roles the migrations grant to, and one
# login user per deployable holding its group role. On RDS the same users come from the Terraform root module.
# Passwords default to local-only values and can be overridden from the environment.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v keycloak_password="${SR_LOCAL_KEYCLOAK_DB_PASSWORD:-keycloak-local}" \
  -v api_password="${SR_LOCAL_API_DB_PASSWORD:-api-local}" \
  -v report_worker_password="${SR_LOCAL_REPORT_WORKER_DB_PASSWORD:-report-worker-local}" \
  -v mail_worker_password="${SR_LOCAL_MAIL_WORKER_DB_PASSWORD:-mail-worker-local}" <<'SQL'
CREATE ROLE sr_api NOLOGIN;
CREATE ROLE sr_report_worker NOLOGIN;
CREATE ROLE sr_mail_worker NOLOGIN;

CREATE ROLE keycloak LOGIN PASSWORD :'keycloak_password';
CREATE ROLE api LOGIN PASSWORD :'api_password' IN ROLE sr_api;
CREATE ROLE report_worker LOGIN PASSWORD :'report_worker_password' IN ROLE sr_report_worker;
CREATE ROLE mail_worker LOGIN PASSWORD :'mail_worker_password' IN ROLE sr_mail_worker;

CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
REVOKE CONNECT ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO api, report_worker, mail_worker;
SQL
