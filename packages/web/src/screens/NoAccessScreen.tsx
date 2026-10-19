import { FOCUS } from '../session/controller'

export interface NoAccessScreenProps {
  /* The NoAccessProblem title, verbatim: "You don't have access. Signed in as <UPN>." */
  message: string
  signOutFailed: boolean
  onSignInWithDifferentAccount: () => void
  onSignOut: () => void
}

/* SCR-1, denied (AC-5). */
export function NoAccessScreen({
  message,
  signOutFailed,
  onSignInWithDifferentAccount,
  onSignOut,
}: NoAccessScreenProps) {
  return (
    <main className="sign-in">
      <h1 id={FOCUS.deniedHeading} tabIndex={-1}>
        You don't have access
      </h1>
      <p>{message}</p>
      <p>Ask your Entra administrator to add you to the reader group.</p>
      {signOutFailed && <p className="error">Sign-out didn't complete. Try again.</p>}
      <div className="actions">
        <button type="button" className="button button--primary" onClick={onSignInWithDifferentAccount}>
          Sign in with a different account
        </button>
        <button type="button" className="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </main>
  )
}
