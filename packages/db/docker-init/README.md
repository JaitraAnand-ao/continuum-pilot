# packages/db/docker-init

Mounted into the postgres service as `/docker-entrypoint-initdb.d`. `10-roles-and-keycloak.sh` runs once
when the volume is first created and makes:

- the `keycloak` database, owned by the `keycloak` login role (CMP-6);
- the `sr_api`, `sr_report_worker` and `sr_mail_worker` group roles, which the migrations grant to (AD-10);
- one login user per deployable (`api`, `report_worker`, `mail_worker`) holding its group role.

Passwords are local-only defaults, overridable with the `SR_LOCAL_*_DB_PASSWORD` variables. The `migrate`
service runs the migrations as the database owner (`signin_reports`).
