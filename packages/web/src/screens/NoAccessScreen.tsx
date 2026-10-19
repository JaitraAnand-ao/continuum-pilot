import { COPY } from '../copy'
import { FOCUS_IDS } from '../presentation'
import { StatusIcon } from './StatusIcon'

/* AC-5: the account line is the BFF's problem title verbatim ('… Signed in as <UPN>.'). */
export function NoAccessScreen({
  message,
  onSignInWithDifferentAccount,
  onSignOut,
}: {
  message: string
  onSignInWithDifferentAccount: () => void
  onSignOut: () => void
}) {
  return (
    <main className="frame">
      <h1 id={FOCUS_IDS.noAccessHeading} tabIndex={-1}>
        <StatusIcon kind="locked" />
        {COPY.noAccess.heading}
      </h1>
      <p role="alert">{message}</p>
      <p>{COPY.noAccess.askAdministrator}</p>
      <div className="actions">
        <button type="button" className="button button--primary" onClick={onSignInWithDifferentAccount}>
          {COPY.noAccess.differentAccount}
        </button>
        <button type="button" className="button" onClick={onSignOut}>
          {COPY.noAccess.signOut}
        </button>
      </div>
    </main>
  )
}
