-- AD-10: Keycloak keeps its realm in its own database, owned by its own role, with nothing
-- granted on the application database.
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
