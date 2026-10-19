# infra/keycloak

CMP-6: realm as code (AD-6, AD-19). FIPS Keycloak 26.8.1 image built from source — BouncyCastle FIPS provider, BCFKS keystores, fips-mode=strict — with realm signin-reports and the fake-entra realm for local sign-in.

## What is here

| Path                                 | What it is                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `realms/signin-reports-realm.json`   | The production realm export, baked into the image and imported with `--import-realm`                       |
| `realms/local/fake-entra-realm.json` | Stand-in for Entra ID, local and test only; mounted by Compose, never copied into the image                |
| `Dockerfile`, `conf/keycloak.conf`   | The FIPS build: digest-pinned base, BC FIPS jars verified by checksum, `fips-mode=strict`                  |
| `docker-entrypoint.sh`               | Refuses to start Keycloak while any bootstrap-admin variable is set                                        |
| `scripts/check-bootstrap-admin.sh`   | Post-deploy check (runs the `.mjs`): fails the deployment while the temporary bootstrap admin still exists |
| `test/`                              | Realm, image, guard and check tests, plus the fake-entra integration suite                                 |

## The signin-reports realm (AD-6)

- **Entra ID is the only way in.** The browser flow is the session cookie or the Identity Provider Redirector straight to
  `entra`; there is no login form. Direct grant, registration, credential reset and docker login are bound to a flow that
  denies access. The realm holds no local users.
- **FORCE sync.** The identity provider and every mapper re-sync from the Entra claims at each sign-in, so removing someone
  from the reader group takes effect at their next sign-in.
- **Tenant check.** Only tokens whose `tid` claim equals `SR_ENTRA_TENANT_ID` are accepted.
- **Re-authentication (TQ-5).** The identity provider forwards `max_age` and `prompt` to Entra and fixes no prompt of its own,
  so when the BFF asks for `max_age=900` or `prompt=login`, Entra itself re-prompts instead of reusing its SSO session.
- **Roles.** Entra app role `SignInReports.Reader` maps to realm role `reader`, `SignInReports.Admin` to `report-admin`. The
  default role grants neither, so an account in neither group signs in with no role and the BFF answers 403 (AC-5, AC-7).
  The username is the Entra `oid`; email is never trusted for identity.
- **Sessions (AC-9).** 15 minutes idle, 8 hours in total; access tokens live 5 minutes; refresh tokens are single-use.
- **BFF client.** `signin-reports-bff` is confidential, authorization code with PKCE only, redirects only to
  `${SR_PUBLIC_ORIGIN}/auth/callback`, and receives `roles`, `upn` and `auth_time`. The tokens stay in the BFF (AC-8).
- **Audit.** Login, login-error, logout and broker events are recorded.

## Environment placeholders

Keycloak resolves these when it imports the realm. Secrets come from Secrets Manager into the task's environment by ARN;
none is ever written into a file here.

| Placeholder                  | Production value                                                                      | Secret |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------ |
| `SR_PUBLIC_ORIGIN`           | The dashboard origin behind the ALB, e.g. `https://signin-reports.agency.gov`         | no     |
| `SR_BFF_CLIENT_SECRET`       | Secret of the `signin-reports-bff` client, shared only with the api task              | yes    |
| `SR_ENTRA_TENANT_ID`         | The organization's Entra tenant ID (the only accepted `tid`)                          | no     |
| `SR_ENTRA_CLIENT_ID`         | Application (client) ID of the Entra registration                                     | no     |
| `SR_ENTRA_CLIENT_SECRET`     | Client secret of the Entra registration                                               | yes    |
| `SR_ENTRA_ISSUER`            | `https://login.microsoftonline.us/<tenant>/v2.0`                                      | no     |
| `SR_ENTRA_AUTHORIZATION_URL` | `https://login.microsoftonline.us/<tenant>/oauth2/v2.0/authorize`                     | no     |
| `SR_ENTRA_TOKEN_URL`         | `https://login.microsoftonline.us/<tenant>/oauth2/v2.0/token`                         | no     |
| `SR_ENTRA_JWKS_URL`          | `https://login.microsoftonline.us/<tenant>/discovery/v2.0/keys`                       | no     |
| `SR_ENTRA_LOGOUT_URL`        | `https://login.microsoftonline.us/<tenant>/oauth2/v2.0/logout`                        | no     |
| `FAKE_ENTRA_TENANT_ID`       | Local only: the tenant the fake-entra users belong to; set `SR_ENTRA_TENANT_ID` to it | no     |
| `FAKE_ENTRA_CLIENT_SECRET`   | Local only: the broker client secret; set `SR_ENTRA_CLIENT_SECRET` to it              | local  |
| `FAKE_ENTRA_USER_PASSWORD`   | Local only: the password of every fake-entra user (14+ characters: FIPS strict)       | local  |

The Microsoft endpoints are the Azure Government (`login.microsoftonline.us`) authority, so nothing in the realm is tied to
the commercial cloud; a commercial deployment sets the same placeholders to its own authority. Locally the endpoints point
at the fake-entra realm, e.g. `SR_ENTRA_AUTHORIZATION_URL=${SR_PUBLIC_ORIGIN}/realms/fake-entra/protocol/openid-connect/auth`
and `SR_ENTRA_ISSUER=${SR_PUBLIC_ORIGIN}/realms/fake-entra`.

## The fake-entra realm

Emits `oid`, `tid` and a flat `roles` claim like Entra. Its users cover every persona of ST-1:

| User                         | App roles     | Tenant  |
| ---------------------------- | ------------- | ------- |
| `reader@fake-entra.test`     | Reader        | ours    |
| `both@fake-entra.test`       | Reader, Admin | ours    |
| `admin-only@fake-entra.test` | Admin         | ours    |
| `outsider@fake-entra.test`   | none          | ours    |
| `foreign@other-tenant.test`  | Reader        | foreign |

## The image

```sh
docker build infra/keycloak \
  --build-arg KEYCLOAK_DIGEST=sha256:<reviewed digest of quay.io/keycloak/keycloak:26.8.1> \
  --build-arg BC_FIPS_SHA256=<sha256> --build-arg BCTLS_FIPS_SHA256=<sha256> --build-arg BCUTIL_FIPS_SHA256=<sha256>
```

The digest and checksums have no defaults: a build without the reviewed values fails instead of floating. The keystore and
truststore are BCFKS; their paths and passwords arrive as `KC_HTTPS_KEY_STORE_FILE`, `KC_HTTPS_KEY_STORE_PASSWORD`,
`KC_HTTPS_TRUST_STORE_FILE` and `KC_HTTPS_TRUST_STORE_PASSWORD`, the passwords from Secrets Manager.

## The bootstrap admin

The temporary admin is created once, by a one-off `kc.sh bootstrap-admin` task, and replaced by a permanent operator
account. Then:

- the image's entrypoint refuses to start while any of `KC_BOOTSTRAP_ADMIN_USERNAME`, `KC_BOOTSTRAP_ADMIN_PASSWORD`,
  `KC_BOOTSTRAP_ADMIN_CLIENT_ID`, `KC_BOOTSTRAP_ADMIN_CLIENT_SECRET`, `KEYCLOAK_ADMIN` or `KEYCLOAK_ADMIN_PASSWORD` is set,
  so a task definition that still carries it never becomes healthy;
- `infra/keycloak/scripts/check-bootstrap-admin.sh`, run after each deployment with `SR_KEYCLOAK_ADMIN_URL` (the
  internal admin URL, never routed by the edge) and `SR_KEYCLOAK_ADMIN_TOKEN` (the operator's token), exits 1 — failing the
  deployment — while a user or client marked `is_temporary_admin` remains in the master realm.

## Tests

```sh
npx vitest run --config infra/keycloak/vitest.config.ts
```

`test/fake-entra.integration.test.ts` runs only when `SR_KEYCLOAK_TEST_URL` points at a running Keycloak with both realms
imported (with `SR_BFF_CLIENT_SECRET` and `FAKE_ENTRA_USER_PASSWORD` set); it proves role mapping, denial, the tenant check
and that a request whose `auth_time` is older than `max_age` makes fake-entra re-prompt.
