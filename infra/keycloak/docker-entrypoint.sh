#!/bin/sh
# AD-6: the temporary bootstrap admin is created once by a one-off `kc.sh bootstrap-admin`
# task and then removed. A task definition that still carries its credentials must fail
# to start rather than recreate or keep it.
set -eu

kc_sh="${SR_KC_SH:-/opt/keycloak/bin/kc.sh}"

refused=""
for name in KC_BOOTSTRAP_ADMIN_USERNAME KC_BOOTSTRAP_ADMIN_PASSWORD KC_BOOTSTRAP_ADMIN_CLIENT_ID \
  KC_BOOTSTRAP_ADMIN_CLIENT_SECRET KEYCLOAK_ADMIN KEYCLOAK_ADMIN_PASSWORD; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then
    refused="$refused $name"
  fi
done

if [ -n "$refused" ]; then
  echo "refusing to start: bootstrap admin still configured (${refused# }); remove it from the task definition" >&2
  exit 64
fi

exec "$kc_sh" "$@"
