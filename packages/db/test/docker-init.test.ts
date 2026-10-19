import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const initDir = join(import.meta.dirname, '..', 'docker-init')
const sql = () =>
  readdirSync(initDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(initDir, name), 'utf8'))
    .join('\n')

describe('docker-init (local postgres bootstrap)', () => {
  it('creates the keycloak database owned by its own role', () => {
    expect(sql()).toMatch(/CREATE ROLE keycloak LOGIN/)
    expect(sql()).toMatch(/CREATE DATABASE keycloak OWNER keycloak/)
  })

  it('creates one login role per deployable plus the migrator', () => {
    for (const role of ['sr_migrator', 'sr_api', 'sr_report_worker', 'sr_mail_worker']) {
      expect(sql()).toMatch(new RegExp(`CREATE ROLE ${role} LOGIN`))
    }
  })

  it('keeps keycloak and the application out of each other’s database', () => {
    expect(sql()).toMatch(/REVOKE ALL ON DATABASE keycloak FROM PUBLIC/)
    expect(sql()).toMatch(/REVOKE ALL ON DATABASE signin_reports FROM PUBLIC/)
    expect(sql()).toMatch(
      /GRANT CONNECT ON DATABASE signin_reports TO sr_migrator, sr_api, sr_report_worker, sr_mail_worker/,
    )
    expect(sql()).not.toMatch(/GRANT[^;]*DATABASE signin_reports[^;]*keycloak/)
  })

  it('lets only the migrator create objects', () => {
    expect(sql()).toMatch(/GRANT CREATE ON DATABASE signin_reports TO sr_migrator;/)
    expect(sql()).toMatch(/GRANT CREATE ON SCHEMA public TO sr_migrator;/)
    expect(sql()).not.toMatch(/GRANT CREATE[^;]*sr_(api|report_worker|mail_worker)/)
  })

  it('never grants ALL and never makes a superuser', () => {
    expect(sql()).toMatch(/CREATE ROLE/)
    expect(sql()).not.toMatch(/GRANT ALL/i)
    expect(sql()).not.toMatch(/SUPERUSER|CREATEROLE|BYPASSRLS/i)
  })
})
