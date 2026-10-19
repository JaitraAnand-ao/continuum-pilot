#!/bin/bash
# Guards the Keycloak server start (AD-6). The temporary bootstrap admin is created once by a
# one-off `kc.sh bootstrap-admin` task and then removed; if any bootstrap or legacy admin
# variable is still in the task definition, the server refuses to start and the ECS deployment
# fails. It also refuses start-dev and any FIPS mode other than strict.
set -euo pipefail

kc_sh="${KC_SH:-/opt/keycloak/bin/kc.sh}"

fail() {
  echo "docker-entrypoint: $1" >&2
  exit 64
}

if [[ "${1:-}" == "start-dev" ]]; then
  fail "start-dev disables TLS and FIPS strict mode; use start --optimized"
fi

if [[ "${1:-}" == "start" ]]; then
  for name in \
    KC_BOOTSTRAP_ADMIN_USERNAME \
    KC_BOOTSTRAP_ADMIN_PASSWORD \
    KC_BOOTSTRAP_ADMIN_CLIENT_ID \
    KC_BOOTSTRAP_ADMIN_CLIENT_SECRET \
    KEYCLOAK_ADMIN \
    KEYCLOAK_ADMIN_PASSWORD; do
    if [[ -n "${!name+set}" ]]; then
      fail "$name is set; remove the bootstrap admin from the task definition before starting"
    fi
  done
  if [[ -n "${KC_FIPS_MODE+set}" && "${KC_FIPS_MODE}" != "strict" ]]; then
    fail "KC_FIPS_MODE=${KC_FIPS_MODE}; fips-mode must be strict"
  fi
  for arg in "$@"; do
    case "$arg" in
      --fips-mode=strict) ;;
      --fips-mode*) fail "$arg; fips-mode must be strict" ;;
    esac
  done
fi

exec "$kc_sh" "$@"
