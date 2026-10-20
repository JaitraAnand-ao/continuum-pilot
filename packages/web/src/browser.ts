/* Adapters from the controller's ports to the browser. Nothing here reads or writes storage or
 * cookies: the session lives only in the httpOnly __Host-sr_session cookie (AC-8). */
import type { Clock, Navigator } from './session/controller'

export interface BrowserWindow {
  location: { pathname: string; search: string; assign(url: string): void }
  history: {
    pushState(data: unknown, unused: string, url: string): void
    replaceState(data: unknown, unused: string, url: string): void
  }
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export function browserNavigator(win: BrowserWindow): Navigator {
  return {
    path: () => win.location.pathname,
    search: () => win.location.search,
    push: (path) => win.history.pushState(null, '', path),
    replace: (path) => win.history.replaceState(null, '', path),
    assign: (url) => win.location.assign(url),
  }
}

export function browserClock(win: BrowserWindow, now: () => number = Date.now): Clock {
  return {
    now,
    setTimeout: (callback, ms) => win.setTimeout(callback, ms),
    clearTimeout: (handle) => win.clearTimeout(handle),
  }
}
