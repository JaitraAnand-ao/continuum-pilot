import { describe, expect, it, vi } from 'vitest'
import { browserClock, browserNavigator, type BrowserWindow } from './browser'

function fakeWindow(): BrowserWindow {
  return {
    location: { pathname: '/reports/daily', search: '?error=x', assign: vi.fn() },
    history: { pushState: vi.fn(), replaceState: vi.fn() },
    setTimeout: vi.fn(() => 7),
    clearTimeout: vi.fn(),
  }
}

describe('browserNavigator', () => {
  it('reads the address and moves through history', () => {
    const win = fakeWindow()
    const navigator = browserNavigator(win)
    expect(navigator.path()).toBe('/reports/daily')
    expect(navigator.search()).toBe('?error=x')
    navigator.push('/reports/history')
    navigator.replace('/')
    navigator.assign('/auth/login')
    expect(win.history.pushState).toHaveBeenCalledWith(null, '', '/reports/history')
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(win.location.assign).toHaveBeenCalledWith('/auth/login')
  })
})

describe('browserClock', () => {
  it('delegates timers to the window', () => {
    const win = fakeWindow()
    const clock = browserClock(win, () => 42)
    const callback = () => undefined
    expect(clock.now()).toBe(42)
    expect(clock.setTimeout(callback, 10)).toBe(7)
    clock.clearTimeout(7)
    expect(win.setTimeout).toHaveBeenCalledWith(callback, 10)
    expect(win.clearTimeout).toHaveBeenCalledWith(7)
  })

  it('tells the time from the system by default', () => {
    expect(Math.abs(browserClock(fakeWindow()).now() - Date.now())).toBeLessThan(1000)
  })
})
