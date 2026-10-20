import { FOCUS, TEXT } from '../session/controller'

export interface IdleWarningDialogProps {
  onStaySignedIn: () => void
  onSignOut: () => void
}

/* AC-9. The assertive announcement comes from the live region, so the dialog is a plain dialog
 * rather than an alertdialog, which would announce it a second time. */
export function IdleWarningDialog({ onStaySignedIn, onSignOut }: IdleWarningDialogProps) {
  return (
    <div className="dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="idle-warning-title"
        aria-describedby="idle-warning-text"
        className="dialog"
      >
        <h2 id="idle-warning-title">Are you still there?</h2>
        <p id="idle-warning-text">{TEXT.idleWarning}</p>
        <div className="actions">
          <button id={FOCUS.staySignedIn} type="button" className="button button--primary" onClick={onStaySignedIn}>
            Stay signed in
          </button>
          <button type="button" className="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
