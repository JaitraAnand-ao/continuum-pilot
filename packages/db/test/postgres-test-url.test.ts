import { describe, expect, it } from 'vitest'
import { postgresTestUrl } from './postgres-test-url.js'

describe('postgresTestUrl (which Postgres the integration suite runs against)', () => {
  it('answers undefined without SR_DB_TEST_URL, so the suite skips, under CI too', () => {
    expect(postgresTestUrl({})).toBeUndefined()
    expect(postgresTestUrl({ CI: 'true' })).toBeUndefined()
  })

  it('treats an empty SR_DB_TEST_URL as unset', () => {
    expect(postgresTestUrl({ SR_DB_TEST_URL: '' })).toBeUndefined()
  })

  it('answers the URL when it names a Postgres server', () => {
    const url = 'postgres://signin_reports:signin_reports@localhost:5432/signin_reports'
    expect(postgresTestUrl({ SR_DB_TEST_URL: url })).toBe(url)
    expect(postgresTestUrl({ SR_DB_TEST_URL: 'postgresql://localhost/postgres' })).toBe(
      'postgresql://localhost/postgres',
    )
  })

  it('refuses a value that is not a URL rather than skipping', () => {
    expect(() => postgresTestUrl({ SR_DB_TEST_URL: 'localhost:5432' })).toThrow(/SR_DB_TEST_URL/)
  })

  it('refuses a URL for anything but Postgres', () => {
    expect(() => postgresTestUrl({ SR_DB_TEST_URL: 'mysql://localhost/db' })).toThrow(/SR_DB_TEST_URL/)
  })

  it('refuses a Postgres URL without a host', () => {
    expect(() => postgresTestUrl({ SR_DB_TEST_URL: 'postgres:///signin_reports' })).toThrow(/SR_DB_TEST_URL/)
  })
})
