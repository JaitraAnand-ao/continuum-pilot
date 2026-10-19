import { describe, expect, it } from 'vitest'
import * as web from './index'

describe('@signin-reports/web entry', () => {
  it('exposes the app, its browser ports and the session controller', () => {
    expect(Object.keys(web).sort()).toEqual(['App', 'createBrowserPorts', 'createSessionController'])
  })
})
