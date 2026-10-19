import { COPY, pageTitle } from './copy'
import { SCREENS } from './session/roles'
import type { AppState } from './session/controller'

/* Page title and focus target for each state, applied to the document after every render. */

export const FOCUS_IDS = {
  signInButton: 'sign-in-button',
  signingInHeading: 'signing-in-heading',
  noAccessHeading: 'no-access-heading',
  failedHeading: 'sign-in-failed-heading',
  unavailableHeading: 'unavailable-heading',
  screenHeading: 'screen-heading',
  staySignedIn: 'stay-signed-in',
} as const

export function titleFor(state: AppState): string {
  switch (state.kind) {
    case 'checking':
      return pageTitle(COPY.signingIn.title)
    case 'signed-out':
      return pageTitle(COPY.signIn.title)
    case 'denied':
      return pageTitle(COPY.noAccess.title)
    case 'failed':
      return pageTitle(COPY.failed.title)
    case 'unavailable':
      return pageTitle(COPY.unavailable.title)
    case 'signed-in':
      return pageTitle(SCREENS[state.screen].heading)
  }
}

export function focusTargetFor(state: AppState): string {
  switch (state.kind) {
    case 'checking':
      return FOCUS_IDS.signingInHeading
    case 'signed-out':
      return FOCUS_IDS.signInButton
    case 'denied':
      return FOCUS_IDS.noAccessHeading
    case 'failed':
      return FOCUS_IDS.failedHeading
    case 'unavailable':
      return FOCUS_IDS.unavailableHeading
    case 'signed-in':
      return state.warning ? FOCUS_IDS.staySignedIn : FOCUS_IDS.screenHeading
  }
}

interface Focusable {
  focus(): void
  readonly isConnected?: boolean
}

export interface FocusDocument {
  title: string
  activeElement: unknown
  getElementById(id: string): Focusable | null
}

const isFocusable = (value: unknown): value is Focusable =>
  typeof value === 'object' && value !== null && typeof (value as Focusable).focus === 'function'

/* Moves focus when the target changes. Opening the idle dialog remembers where focus was,
 * and closing it returns focus there rather than to the top of the screen. */
export class FocusManager {
  private current: string | undefined
  private beforeDialog: Focusable | undefined

  update(doc: FocusDocument, target: string): void {
    if (target === this.current) return
    const previous = this.current
    this.current = target
    if (target === FOCUS_IDS.staySignedIn) {
      this.beforeDialog = isFocusable(doc.activeElement) ? doc.activeElement : undefined
    } else if (previous === FOCUS_IDS.staySignedIn && target === FOCUS_IDS.screenHeading) {
      const restore = this.beforeDialog
      this.beforeDialog = undefined
      if (restore !== undefined && restore.isConnected !== false) {
        restore.focus()
        return
      }
    }
    doc.getElementById(target)?.focus()
  }
}

export function applyTitle(doc: FocusDocument, state: AppState): void {
  doc.title = titleFor(state)
}
