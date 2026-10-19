# packages/db/docker-init

Mounted into the postgres service as `/docker-entrypoint-initdb.d`; runs once when the volume is first created.

- `10-roles-and-keycloak.sh` creates the `keycloak` database and owner, the group roles `sr_api`,
  `sr_report_worker` and `sr_mail_worker` that the migrations grant to (AD-10), and one login user per
  deployable holding its group role. Passwords are local-only defaults, overridable with `SR_LOCAL_*_DB_PASSWORD`.

The tables and grants themselves come from the committed migrations in `../migrations`, never from here.
