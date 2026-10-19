/* AC-9: the idle warning. Modal (the page behind is inert), focus starts on 'Stay signed
 * in', and the controller announces it assertively through the shared live region. */
import { COPY, FOCUS } from '../copy'
import { formatUtcTime } from '../app/routes'
import { Icon } from './Icon'

export function IdleWarningDialog({
  idleExpiresAt,
  onStay,
  onSignOut,
}: {
  idleExpiresAt: string
  onStay: () => void
  onSignOut: () => void
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-warning-title"
      aria-describedby="idle-warning-body"
      className="dialog"
    >
      <Icon name="clock" />
      <h2 id="idle-warning-title">{COPY.idle.title}</h2>
      <p id="idle-warning-body">{COPY.idle.body(formatUtcTime(idleExpiresAt))}</p>
      <button type="button" id={FOCUS.staySignedIn} onClick={onStay}>
        {COPY.idle.stay}
      </button>
      <button type="button" onClick={onSignOut}>
        {COPY.idle.signOut}
      </button>
    </div>
  )
}
