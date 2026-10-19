import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cookieFrom, createHarness, READER, type Harness } from '../test-support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.close()
})

const logout = (cookie?: string) =>
  h.app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: cookie === undefined ? {} : { cookie: `__Host-sr_session=${cookie}` },
  })
const me = (cookie: string) =>
  h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `__Host-sr_session=${cookie}` } })

describe('AC-9 POST /auth/logout', () => {
  it('ends the session, ends the Keycloak session and clears the cookie', async () => {
    const cookie = await h.signIn(READER)
    const refreshToken = h.kc.refreshTokens.at(-1)
    const response = await logout(cookie)
    expect(response.statusCode).toBe(204)
    expect(cookieFrom(response, '__Host-sr_session')).toMatch(
      /^__Host-sr_session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Strict$/,
    )
    expect(h.sessions.rows()).toHaveLength(0)
    expect(h.kc.logoutRequests).toEqual([
      { client_id: h.kc.clientId, client_secret: h.kc.clientSecret, refresh_token: refreshToken },
    ])
  })

  it('answers 401 to the old session cookie afterwards', async () => {
    const cookie = await h.signIn(READER)
    await logout(cookie)
    expect((await me(cookie)).statusCode).toBe(401)
  })

  it('still ends the local session when Keycloak cannot be reached', async () => {
    const cookie = await h.signIn(READER)
    await h.kc.close()
    const response = await logout(cookie)
    expect(response.statusCode).toBe(204)
    expect(h.sessions.rows()).toHaveLength(0)
  })

  it('is harmless without a session', async () => {
    const response = await logout()
    expect(response.statusCode).toBe(204)
    expect(h.kc.logoutRequests).toHaveLength(0)
  })
})
