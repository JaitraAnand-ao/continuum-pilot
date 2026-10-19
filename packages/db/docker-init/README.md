# packages/db/docker-init

Mounted into the postgres service as `/docker-entrypoint-initdb.d`. CMP-5 commits the
role-creation SQL here (per-role grants — AD-10); until then the database starts with
only the default `signin_reports` role.
