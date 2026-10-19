import { copy } from '../copy'
import { StatusIcon } from './StatusIcon'

export interface SignInScreenProps {
  notice: 'signedOut' | 'expired' | null
  onSignIn: () => void
}

/* SCR-1 sign-in frame (AC-1). */
export function SignInScreen({ notice, onSignIn }: SignInScreenProps) {
  return (
    <main className="signin">
      <h1 id="page-heading" tabIndex={-1}>
        {copy.signIn.heading}
      </h1>
      {notice && (
        <p className="signin__notice">
          <StatusIcon tone="info" /> {copy.signIn[notice]}
        </p>
      )}
      <p className="signin__personal-data">
        <StatusIcon tone="info" /> {copy.signIn.personalData}
      </p>
      <button id="signin-button" type="button" className="button button--primary" onClick={onSignIn}>
        {copy.signIn.button}
      </button>
      <p>{copy.signIn.readOnly}</p>
      <p>{copy.signIn.entraAccount}</p>
    </main>
  )
}
