-- Local only: runs once as POSTGRES_USER when the postgres volume is first
-- created. Passwords match the role names, like POSTGRES_PASSWORD in docker-compose.yml;
-- production roles and their Secrets Manager passwords come from the RDS Terraform.

-- CMP-6 Keycloak keeps its own database, out of reach of the application roles.
CREATE ROLE keycloak LOGIN PASSWORD 'keycloak';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;

-- One role per deployable plus the migrator that owns the schema (AD-10).
CREATE ROLE sr_migrator LOGIN PASSWORD 'sr_migrator';
CREATE ROLE sr_api LOGIN PASSWORD 'sr_api';
CREATE ROLE sr_report_worker LOGIN PASSWORD 'sr_report_worker';
CREATE ROLE sr_mail_worker LOGIN PASSWORD 'sr_mail_worker';

REVOKE ALL ON DATABASE signin_reports FROM PUBLIC;
GRANT CONNECT ON DATABASE signin_reports TO sr_migrator, sr_api, sr_report_worker, sr_mail_worker;
GRANT CREATE ON DATABASE signin_reports TO sr_migrator;
GRANT CREATE ON SCHEMA public TO sr_migrator;
