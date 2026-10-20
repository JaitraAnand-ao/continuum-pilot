import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadModule, routeAlb } from './lib/alb.js'
import { parseNginx, routeNginx } from './lib/nginx.js'
import { ADMIN_PATHS, AD19_ROUTES } from './lib/routes.js'

/* ST-1 sign-in only works if the browser reaches the signin-reports realm and the BFF
 * through one origin, and AC-5/AC-7 only hold if nothing else of Keycloak is reachable. */
const alb = loadModule()
const nginx = parseNginx(readFileSync(new URL('../nginx/edge.conf', import.meta.url), 'utf8'))

describe('AD-19 routing, production ALB', () => {
  it.each(AD19_ROUTES)('$path → $to ($why)', ({ path, to }) => {
    expect(routeAlb(alb, path)).toBe(to)
  })

  it('never forwards a Keycloak admin console or master realm path', () => {
    for (const path of ADMIN_PATHS) expect(routeAlb(alb, path), path).toBe('deny')
  })
})

describe('AD-19 routing, local nginx mirror', () => {
  it.each(AD19_ROUTES)('$path → $to ($why)', ({ path, to }) => {
    expect(routeNginx(nginx, path)).toBe(to)
  })

  it('never forwards a Keycloak admin console or master realm path', () => {
    for (const path of ADMIN_PATHS) expect(routeNginx(nginx, path), path).toBe('deny')
  })
})

describe('the two edges agree', () => {
  it('routes every AD-19 request to the same place locally and in production', () => {
    for (const { path } of AD19_ROUTES) expect(routeNginx(nginx, path), path).toBe(routeAlb(alb, path))
  })
})
