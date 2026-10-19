import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DB_ROLES } from './roles.js'
import {
  TEST_CONNECT_TIMEOUT_MS,
  TEST_STATEMENT_TIMEOUT_MS,
  migratedOwnerPool,
  poolAs,
  testDatabaseUrl,
} from './test-database.js'

/* A server that accepts the TCP connection and never answers the startup message: without a
 * connect timeout the driver waits forever and CI never finishes. */
describe('test pools against a server that never answers', () => {
  let server: Server
  const sockets: Socket[] = []
  let url: string

  beforeAll(async () => {
    server = createServer((socket) => sockets.push(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `postgresql://nobody:nothing@127.0.0.1:${(server.address() as AddressInfo).port}/none`
  })
  afterAll(async () => {
    sockets.forEach((s) => s.destroy())
    await new Promise((resolve) => server.close(resolve))
  })

  it(
    'the owner pool gives up instead of hanging',
    async () => {
      await expect(migratedOwnerPool(url)).rejects.toThrow(/timeout/i)
    },
    TEST_CONNECT_TIMEOUT_MS + 2_000,
  )

  it(
    'a role pool gives up instead of hanging',
    async () => {
      const pool = poolAs(url, DB_ROLES.api)
      try {
        await expect(pool.query('select 1')).rejects.toThrow(/timeout/i)
      } finally {
        await pool.end()
      }
    },
    TEST_CONNECT_TIMEOUT_MS + 2_000,
  )
})

describe.skipIf(!testDatabaseUrl)('test pools on PostgreSQL', () => {
  const url = testDatabaseUrl as string
  const pools: pg.Pool[] = []

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()))
  })

  it('carry a statement timeout so a stuck lock wait fails instead of hanging', async () => {
    const owner = await migratedOwnerPool(url)
    pools.push(owner, poolAs(url, DB_ROLES.api))
    for (const pool of pools) {
      const { rows } = await pool.query<{ statement_timeout: string }>('show statement_timeout')
      expect(rows[0]?.statement_timeout).toBe(`${TEST_STATEMENT_TIMEOUT_MS / 1000}s`)
    }
  })
})
