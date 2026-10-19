# infra/edge

CMP-10: the routing rules both production and Compose follow (AD-19).

| Path                                                                               | Goes to                       |
| ---------------------------------------------------------------------------------- | ----------------------------- |
| `..` anywhere in the path; any `%` in a Keycloak path                              | 404 at the edge               |
| `/admin`, `/admin/*`, `/realms/master`, `/realms/master/*`, `/resources/*/admin/*` | 404 at the edge               |
| `/realms/signin-reports/*`, `/resources/*`                                         | Keycloak, HTTPS 8443          |
| everything else                                                                    | api (SPA and BFF), HTTPS 8443 |

Only 443 is ever open; there is no port-80 listener or redirect. TLS is the restricted FIPS
policy (TLS 1.3 and 1.2, forward-secret AES-GCM, NIST curves) and both hops are encrypted.

- `terraform/` — the module: ALB, its security group, the HTTPS listener and its rules,
  the api and Keycloak target groups. Inputs come from infra/platform (VPC, subnets, service
  security groups), ACM and infra/monitoring (access-log bucket). Every ARN is partition
  neutral; `terraform test` (from `terraform/`) plans it with aws-us-gov values.
- `nginx/default.conf` — the local stand-in, mounted over `/etc/nginx/conf.d/default.conf`
  so the image's port-80 server does not exist. TLS certs come from `npm run certs:local`
  into the gitignored `certs/local/`.
- `test/` — reads both and replays one routing table (`test/routes.ts`) through each:
  `npx vitest run --config infra/edge/vitest.config.ts`.

The Compose service, when the edge joins `docker-compose.yml`:

```yaml
edge: # SVC-7
  image: nginx@sha256:<pinned digest>
  ports:
    - '443:443'
  volumes:
    - ./infra/edge/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
    - ./infra/edge/certs/local:/etc/nginx/certs:ro
  depends_on: [api, keycloak]
```
