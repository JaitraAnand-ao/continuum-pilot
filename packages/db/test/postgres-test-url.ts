/* Which Postgres the integration suite runs against: SR_DB_TEST_URL, a superuser connection.
 * Unset or empty, the suite skips, as it must under CI, whose workflow provisions no Postgres.
 * Set but not a Postgres server URL, it throws, so a typo fails rather than silently skips. */
export function postgresTestUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env.SR_DB_TEST_URL
  if (value === undefined || value === '') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('SR_DB_TEST_URL must be a postgres:// URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('SR_DB_TEST_URL must be a postgres:// URL')
  }
  if (url.hostname === '') throw new Error('SR_DB_TEST_URL must name a host')
  return value
}
