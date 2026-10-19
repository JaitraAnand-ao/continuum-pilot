import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserPorts, type BrowserWindow } from './browser'
import { createSessionController } from './session/controller'
import { jsonResponse, readerMe } from './test-support/fixtures'

function fakeWindow(pathname = '/') {
  const elements: Record<string, { focus: ReturnType<typeof vi.fn> }> = {
    'page-heading': { focus: vi.fn() },
    'signin-button': { focus: vi.fn() },
    'stay-signed-in': { focus: vi.fn() },
  }
  const frames: Array<() => void> = []
  const win = {
    document: {
      title: '',
      activeElement: null as unknown,
      getElementById: (id: string) => elements[id] ?? null,
    },
    location: { pathname, search: '', assign: vi.fn() },
    history: { replaceState: vi.fn() },
    fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(200, readerMe)),
    setTimeout: vi.fn(() => 7),
    clearTimeout: vi.fn(),
    requestAnimationFrame: (task: () => void) => frames.push(task),
  }
  const flushFrames = () => frames.splice(0).forEach((task) => task())
  return { win, elements, flushFrames, ports: createBrowserPorts(win as unknown as BrowserWindow) }
}

afterEach(() => vi.unstubAllGlobals())

describe('browser ports', () => {
  it('set the page title and replace or assign the address', () => {
    const { win, ports } = fakeWindow()
    ports.setTitle('No access – Entra Sign-In Reports')
    ports.replaceUrl('/reports/daily')
    ports.assign('/auth/login')
    expect(win.document.title).toBe('No access – Entra Sign-In Reports')
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/reports/daily')
    expect(win.location.assign).toHaveBeenCalledWith('/auth/login')
  })

  it('move focus once the frame is painted', () => {
    const { elements, flushFrames, ports } = fakeWindow()
    ports.focus('page-heading')
    expect(elements['page-heading']?.focus).not.toHaveBeenCalled()
    flushFrames()
    expect(elements['page-heading']?.focus).toHaveBeenCalledTimes(1)
  })

  it('keep trying on later frames until React has committed the target, then stop', () => {
    const { elements, flushFrames, ports } = fakeWindow()
    const heading = elements['page-heading']!
    delete elements['page-heading']
    ports.focus('page-heading')
    flushFrames()
    flushFrames()
    elements['page-heading'] = heading
    flushFrames()
    flushFrames()
    expect(heading.focus).toHaveBeenCalledTimes(1)
  })

  it('give up on a target that never appears, rather than snatch focus later', () => {
    const { elements, flushFrames, ports } = fakeWindow()
    const button = elements['signin-button']!
    delete elements['signin-button']
    ports.focus('signin-button')
    flushFrames()
    elements['signin-button'] = button
    flushFrames()
    expect(button.focus).toHaveBeenCalledTimes(1)
    delete elements['signin-button']
    ports.focus('signin-button')
    for (let frame = 0; frame < 100; frame++) flushFrames()
    elements['signin-button'] = { focus: vi.fn() }
    flushFrames()
    expect(elements['signin-button'].focus).not.toHaveBeenCalled()
  })

  it("return focus to where it was before the idle warning took it to 'Stay signed in'", () => {
    const { win, elements, flushFrames, ports } = fakeWindow()
    const reportLink = { focus: vi.fn() }
    win.document.activeElement = reportLink
    ports.focus('stay-signed-in')
    flushFrames()
    expect(elements['stay-signed-in']?.focus).toHaveBeenCalled()
    ports.focus('restore')
    flushFrames()
    expect(reportLink.focus).toHaveBeenCalledTimes(1)
    ports.focus('restore')
    flushFrames()
    expect(elements['page-heading']?.focus).toHaveBeenCalledTimes(1)
  })

  it('schedule and cancel timers on the window', () => {
    const { win, ports } = fakeWindow()
    const task = vi.fn()
    const cancel = ports.schedule(1000, task)
    expect(win.setTimeout).toHaveBeenCalledWith(task, 1000)
    cancel()
    expect(win.clearTimeout).toHaveBeenCalledWith(7)
    expect(Math.abs(ports.now() - Date.now())).toBeLessThan(1000)
  })

  it('call IF-4 through the window fetch', async () => {
    const { win, ports } = fakeWindow()
    expect(await ports.api.getMe()).toEqual({ status: 'ok', me: readerMe })
    expect(win.fetch).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({ credentials: 'same-origin' }))
  })
})

describe('@AC-8 Scenario: Tokens stay on the server', () => {
  it('Given I signed in as a reader, the dashboard never touches local storage, session storage or document.cookie', async () => {
    const forbidden = () => {
      throw new Error('the SPA must not use browser storage')
    }
    const trap = new Proxy({}, { get: forbidden, set: forbidden })
    vi.stubGlobal('localStorage', trap)
    vi.stubGlobal('sessionStorage', trap)
    const { win, ports } = fakeWindow('/signing-in')
    Object.defineProperty(win.document, 'cookie', { get: forbidden, set: forbidden })
    const controller = createSessionController(ports)
    await controller.start()
    await controller.staySignedIn()
    await controller.signOut()
    expect(controller.getState().view).toEqual({ kind: 'signIn', notice: 'signedOut' })
    expect(win.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/me', '/api/v1/me', '/auth/logout'])
  })
})
