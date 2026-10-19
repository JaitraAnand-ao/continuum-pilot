/* The browser side of the session controller's ports. Nothing here reads or writes
 * localStorage, sessionStorage or document.cookie: the session is the BFF's httpOnly cookie. */
import { createApiClient } from './api/client'
import type { FocusTarget, Ports } from './session/controller'

export interface BrowserWindow {
  document: Pick<Document, 'getElementById' | 'activeElement'> & { title: string }
  location: { pathname: string; search: string; assign(url: string): void }
  history: { replaceState(data: unknown, unused: string, url: string): void }
  fetch: typeof fetch
  setTimeout(task: () => void, ms: number): number
  clearTimeout(id: number): void
  requestAnimationFrame(task: () => void): number
}

const TARGET_IDS: Record<Exclude<FocusTarget, 'restore'>, string> = {
  'page-heading': 'page-heading',
  'signin-button': 'signin-button',
  'stay-signed-in': 'stay-signed-in',
}

const FOCUS_FRAMES = 30

export function createBrowserPorts(win: BrowserWindow): Ports {
  let returnFocus: HTMLElement | null = null
  return {
    api: createApiClient((input, init) => win.fetch(input, init)),
    location: win.location,
    replaceUrl: (path) => win.history.replaceState(null, '', path),
    assign: (url) => win.location.assign(url),
    setTitle: (title) => {
      win.document.title = title
    },
    focus: (target) => {
      if (target === 'stay-signed-in') returnFocus = win.document.activeElement as HTMLElement | null
      /* Focus after React has committed the frame that holds the target; a view published
       * before the first render commits waits a few more frames for it. */
      const attempt = (framesLeft: number): void => {
        win.requestAnimationFrame(() => {
          const element =
            target === 'restore'
              ? (returnFocus ?? win.document.getElementById(TARGET_IDS['page-heading']))
              : win.document.getElementById(TARGET_IDS[target])
          if (element === null && framesLeft > 0) return attempt(framesLeft - 1)
          if (target === 'restore') returnFocus = null
          element?.focus()
        })
      }
      attempt(FOCUS_FRAMES)
    },
    schedule: (ms, task) => {
      const id = win.setTimeout(task, ms)
      return () => win.clearTimeout(id)
    },
    now: () => Date.now(),
  }
}
