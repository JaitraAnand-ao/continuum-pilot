import { COPY } from '../copy'
import { FOCUS_IDS } from '../presentation'
import { utcClock } from '../session/timing'
import { StatusIcon } from './StatusIcon'

/* AC-9: an alertdialog, so the warning is announced assertively when it opens. The rest of the
 * shell is inert while it is shown. */
export function IdleWarningDialog({
  idleExpiresAt,
  onStaySignedIn,
  onSignOut,
}: {
  idleExpiresAt: string
  onStaySignedIn: () => void
  onSignOut: () => void
}) {
  return (
    <div className="backdrop">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-warning-heading"
        aria-describedby="idle-warning-detail"
        className="dialog"
      >
        <h2 id="idle-warning-heading">
          <StatusIcon kind="warning" />
          {COPY.idle.heading}
        </h2>
        <p id="idle-warning-detail">{COPY.idle.detail(utcClock(idleExpiresAt))}</p>
        <div className="actions">
          <button id={FOCUS_IDS.staySignedIn} type="button" className="button button--primary" onClick={onStaySignedIn}>
            {COPY.idle.staySignedIn}
          </button>
          <button type="button" className="button" onClick={onSignOut}>
            {COPY.idle.signOut}
          </button>
        </div>
      </div>
    </div>
  )
}
