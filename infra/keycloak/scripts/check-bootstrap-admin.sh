#!/bin/sh
# Runs the post-deploy bootstrap-admin check; a non-zero exit fails the deployment.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
exec node --input-type=module -e "
import { main } from '${here}/check-bootstrap-admin.mjs'
process.exitCode = await main({ env: process.env, fetch: globalThis.fetch, log: (line) => console.log(line) })
"
