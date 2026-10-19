import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationsDir = join(import.meta.dirname, '..', 'migrations')
const files = () => readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))
const allSql = () =>
  files()
    .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
    .join('\n')

/* All GRANT statements, whitespace-collapsed. */
const grants = () => [...allSql().matchAll(/GRANT[^;]+;/gi)].map((match) => match[0].replace(/\s+/g, ' ').trim())

describe('committed migrations (AD-10: forward-only, generated)', () => {
  it('every SQL file is listed in the drizzle journal, in order', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[]
    }
    expect(files().length).toBeGreaterThanOrEqual(2)
    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(files().sort())
    expect(journal.entries.map((entry) => entry.idx)).toEqual(files().map((_, index) => index))
  })

  it('never drops anything', () => {
    expect(allSql()).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i)
  })

  it('creates the session table with the hash, GCM parts and both expiries', () => {
    const sql = allSql()
    expect(sql).toMatch(/CREATE TABLE "session"/)
    for (const column of [
      'id_hash',
      'refresh_token_ciphertext',
      'refresh_token_iv',
      'refresh_token_tag',
      'idle_expires_at',
      'absolute_expires_at',
      'ended_at',
    ]) {
      expect(sql).toContain(`"${column}"`)
    }
    expect(sql).not.toMatch(/"(session_id|refresh_token|access_token|id_token)"/)
  })

  it('bounds the session in the database too: 32-byte hash, 96-bit IV, 128-bit tag, 15 minutes idle, 8 hours total', () => {
    const sql = allSql()
    expect(sql).toMatch(/octet_length\("session"\."id_hash"\) = 32/)
    expect(sql).toMatch(/octet_length\("session"\."refresh_token_iv"\) = 12/)
    expect(sql).toMatch(/octet_length\("session"\."refresh_token_tag"\) = 16/)
    expect(sql).toMatch(/interval '15 minutes'/)
    expect(sql).toMatch(/interval '8 hours'/)
  })

  it('creates the append-only audit_event table with its hash chain', () => {
    const sql = allSql()
    expect(sql).toMatch(/CREATE TABLE "audit_event"/)
    expect(sql).toMatch(/"prev_hash"/)
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON audit_event/i)
    expect(sql).toMatch(/BEFORE TRUNCATE ON audit_event/i)
    expect(sql).toMatch(/BEFORE INSERT ON audit_event/i)
    expect(sql).toMatch(/pg_advisory_xact_lock/)
  })

  it('never grants ALL', () => {
    expect(grants().length).toBeGreaterThan(0)
    for (const grant of grants()) expect(grant).not.toMatch(/GRANT ALL/i)
  })

  it('lets the API read sessions, insert them, and update only their activity and end columns', () => {
    const toApi = grants().filter((grant) => /\bTO sr_api\b/.test(grant) && /\bsession\b/.test(grant))
    expect(toApi).toEqual(
      expect.arrayContaining([
        'GRANT SELECT, INSERT ON session TO sr_api;',
        'GRANT UPDATE (last_seen_at, idle_expires_at, ended_at, end_reason) ON session TO sr_api;',
      ]),
    )
    expect(toApi).toHaveLength(2)
  })

  it('lets the API only insert audit events', () => {
    const toApi = grants().filter((grant) => /\bTO sr_api\b/.test(grant) && /audit_event/.test(grant))
    expect(toApi).toEqual(['GRANT INSERT ON audit_event TO sr_api;'])
  })

  it('gives the workers nothing on sessions or the audit log', () => {
    for (const grant of grants()) {
      if (/\b(session|audit_event)\b/.test(grant)) expect(grant).not.toMatch(/sr_(report|mail)_worker/)
    }
  })

  it('runs the chaining trigger as its owner with a pinned search_path', () => {
    expect(allSql()).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/i)
  })
})
