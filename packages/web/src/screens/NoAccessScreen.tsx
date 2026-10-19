import { copy } from '../copy'
import { StatusIcon } from './StatusIcon'

export interface NoAccessScreenProps {
  message: string
  onDifferentAccount: () => void
  onSignOut: () => void
}

/* SCR-1 denied frame (AC-5). The line naming the account is the BFF's problem title, verbatim. */
export function NoAccessScreen({ message, onDifferentAccount, onSignOut }: NoAccessScreenProps) {
  return (
    <main className="signin">
      <h1 id="page-heading" tabIndex={-1}>
        <StatusIcon tone="error" /> {copy.noAccess.heading}
      </h1>
      <p className="signin__account">{message}</p>
      <p>{copy.noAccess.askAdmin}</p>
      <div className="signin__actions">
        <button type="button" className="button button--primary" onClick={onDifferentAccount}>
          {copy.noAccess.differentAccount}
        </button>
        <button type="button" className="button" onClick={onSignOut}>
          {copy.noAccess.signOut}
        </button>
      </div>
    </main>
  )
}
