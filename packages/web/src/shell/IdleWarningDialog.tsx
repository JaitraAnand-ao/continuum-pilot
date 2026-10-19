import { copy } from '../copy'

export interface IdleWarningDialogProps {
  onStay: () => void
  onSignOut: () => void
}

/* AC-9 idle warning. The assertive announcement goes through the shared live region; the
 * dialog is a plain dialog so screen readers do not announce it twice. */
export function IdleWarningDialog({ onStay, onSignOut }: IdleWarningDialogProps) {
  return (
    <div className="dialog-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="idle-warning-heading"
        aria-describedby="idle-warning-detail"
        className="dialog"
      >
        <h2 id="idle-warning-heading">{copy.idle.heading}</h2>
        <p id="idle-warning-detail">{copy.idle.detail}</p>
        <div className="dialog__actions">
          <button id="stay-signed-in" type="button" className="button button--primary" onClick={onStay}>
            {copy.idle.stay}
          </button>
          <button type="button" className="button" onClick={onSignOut}>
            {copy.idle.signOut}
          </button>
        </div>
      </div>
    </div>
  )
}
