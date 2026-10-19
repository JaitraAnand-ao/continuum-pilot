# infra/keycloak

CMP-6: realm as code (AD-6, AD-19). FIPS Keycloak 26.8.1 image built from source — BouncyCastle FIPS provider, BCFKS keystores, fips-mode=strict — with realm signin-reports and the fake-entra realm for local sign-in.

## What is here

| Path                                 | What it is                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `realms/signin-reports-realm.json`   | The only production realm. Imported at start; never edited in the admin console.                      |
| `realms/local/fake-entra-realm.json` | Local and CI stand-in for Entra ID (IF-12/IF-13). Mounted by Compose, never in the image.             |
| `env/local.env`                      | Values for the realm placeholders that point the `entra` broker at fake-entra.                        |
| `env/aws-us-gov.env.tftpl`           | Terraform template of the same values for aws-us-gov (`login.microsoftonline.us`).                    |
| `conf/keycloak.conf`                 | FIPS strict, BCFKS keystore, TLS only on 8443, management on 9000, file vault.                        |
| `docker-entrypoint.sh`               | Refuses to start while a bootstrap admin variable remains, under `start-dev`, or without FIPS strict. |
| `Dockerfile`                         | Two-stage build from the digest-pinned base, BC FIPS jars checked by SHA-256, runs as UID 1000.       |

## Realm signin-reports

- One identity provider, `entra` (OIDC), and a browser flow of cookie → Entra redirector only: no
  local password, registration, reset or direct grant.
- `syncMode` FORCE on the provider and every mapper, so removing an Entra app role removes the
  Keycloak role at the next sign-in.
- ID tokens are accepted only when `tid` is `^${ENTRA_TENANT_ID}$` (claim filter).
- `max_age` and `prompt` from the BFF are forwarded to Entra (TQ-5), so an approval that needs a
  fresh sign-in makes Entra re-prompt instead of reusing its SSO session.
- Entra app roles `SignInReports.Reader` and `SignInReports.Admin` in the `roles` claim map to the
  realm roles `reader` and `report-admin`. The default role grants neither, so an account in
  neither group signs in with no report role and the BFF answers 403 (AC-5, AC-7).
- Usernames come from the Entra `oid`; `tid`, `preferred_username` and `name` are kept for the
  no-access screen and passed to the BFF in the ID token.
- Sessions end after 15 minutes idle or 8 hours (AC-9); refresh tokens rotate with no reuse.

## Secrets

No export, env file or config holds a secret. The realm references only vault entries,
`${vault.bff_client_secret}` and `${vault.entra_client_secret}`, which Keycloak resolves at
runtime from the file vault mounted from Secrets Manager (files `signin-reports_bff_client_secret`
and `signin-reports_entra_client_secret`). Locally the vault files and `ENTRA_CLIENT_SECRET` and
`FAKE_ENTRA_USER_PASSWORD` for fake-entra come from the gitignored `.env`.

## Building

```sh
docker build infra/keycloak \
  --build-arg KEYCLOAK_DIGEST=sha256:… \
  --build-arg BC_FIPS_SHA256=… --build-arg BCTLS_FIPS_SHA256=… \
  --build-arg BCPKIX_FIPS_SHA256=… --build-arg BCUTIL_FIPS_SHA256=…
```

The digest and checksums have no defaults on purpose: the build fails rather than float.

## Tests

The root `vitest.config.ts` collects `packages/*` and `testing/*` only, so these run from their own
config:

```sh
npx vitest run --config infra/keycloak/vitest.config.ts
```
