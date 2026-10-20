# infra/edge

CMP-10: the routing rules both production and Compose follow (AD-19). TLS certs for the local edge come from `npm run certs:local` into the gitignored `certs/local/`.

## AD-19

| Request path                               | Destination                         |
| ------------------------------------------ | ----------------------------------- |
| `/admin`, `/admin/*`                       | 404 at the edge (Keycloak admin)    |
| `/realms/master`, `/realms/master/*`       | 404 at the edge (master realm)      |
| any `..`, `%2e` or `%2f` in the path       | 404 at the edge (traversal)         |
| `/realms/signin-reports/*`                 | Keycloak, HTTPS 8443                |
| `/resources/*`                             | Keycloak, HTTPS 8443                |
| `/realms`, `/realms/*` (every other realm) | 404 at the edge                     |
| everything else                            | api, HTTPS 8443 (BFF and SPA, AD-3) |

Only 443 listens, with `ELBSecurityPolicy-TLS13-1-2-FIPS-2023-04` (TLS 1.3/1.2, AES-GCM). There is no port 80 listener. Both target groups re-encrypt. Keycloak is health-checked on its management port 9000, and no rule routes to that port.

## Layout

- `terraform/` is the production ALB root module: listener, rules, target groups and security group. It is written in Terraform JSON syntax so the Node tests can read it without a Terraform binary. The partition comes from `aws_partition`, and the provider and S3 backend use FIPS endpoints. Inputs come from infra/platform (VPC, subnets, task security groups) and infra/monitoring (access-log bucket). The outputs give the target group ARNs to the ECS services.
- `nginx/edge.conf` is the local stand-in. Mount it as `/etc/nginx/conf.d/default.conf`, with `certs/local/` mounted at `/etc/nginx/certs`. The upstreams are `api:8443` and `keycloak:8443`.

## Tests

- `npx vitest run --config infra/edge/vitest.config.ts` sends one AD-19 request table through both the ALB rules and the nginx locations. It checks that both send every request to the same place and that no admin or master-realm path is ever forwarded. It also checks the listener, TLS, target groups, security group, partition and secret rules.
- `terraform test` (run in `terraform/`, Terraform >= 1.7) makes plan assertions against a mocked provider pinned to `aws-us-gov`.
