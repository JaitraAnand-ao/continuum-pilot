import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { here } from './load'

/* The image entrypoint refuses to start Keycloak while any bootstrap-admin variable is set,
 * so a task definition that still carries the bootstrap admin fails its deployment. */

const entrypoint = join(here, 'docker-entrypoint.sh')
const stubDir = mkdtempSync(join(tmpdir(), 'sr-kc-'))
const stub = join(stubDir, 'kc.sh')
writeFileSync(stub, '#!/bin/sh\necho "kc.sh $*"\n')
chmodSync(stub, 0o755)

const run = (env: Record<string, string> = {}) =>
  spawnSync('sh', [entrypoint, 'start', '--optimized', '--import-realm'], {
    env: { PATH: process.env.PATH ?? '', SR_KC_SH: stub, ...env },
    encoding: 'utf8',
  })

describe('docker-entrypoint.sh', () => {
  it('hands the arguments to kc.sh when no bootstrap admin is configured', () => {
    const result = run()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('kc.sh start --optimized --import-realm')
  })

  it.each([
    'KC_BOOTSTRAP_ADMIN_USERNAME',
    'KC_BOOTSTRAP_ADMIN_PASSWORD',
    'KC_BOOTSTRAP_ADMIN_CLIENT_ID',
    'KC_BOOTSTRAP_ADMIN_CLIENT_SECRET',
    'KEYCLOAK_ADMIN',
    'KEYCLOAK_ADMIN_PASSWORD',
  ])('refuses to start while %s is set', (name) => {
    const result = run({ [name]: 'anything' })
    expect(result.status).toBe(64)
    expect(result.stdout).not.toContain('kc.sh')
    expect(result.stderr).toContain(name)
  })

  it('treats an empty bootstrap variable as unset', () => {
    expect(run({ KC_BOOTSTRAP_ADMIN_PASSWORD: '' }).status).toBe(0)
  })
})
