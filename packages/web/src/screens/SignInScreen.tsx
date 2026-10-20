import { FOCUS } from '../session/controller'

export interface SignInScreenProps {
  notice: string | null
  onSignIn: () => void
}

/* SCR-1, signed out (AC-1). */
export function SignInScreen({ notice, onSignIn }: SignInScreenProps) {
  return (
    <main className="sign-in">
      <h1>Entra Sign-In Reports</h1>
      {notice !== null && <p className="sign-in__notice">{notice}</p>}
      <section aria-labelledby="personal-data-heading" className="notice">
        <h2 id="personal-data-heading">Personal data</h2>
        <p>The reports contain personal data. Only the reader group and report administrators can open them.</p>
      </section>
      <button id={FOCUS.signInButton} type="button" className="button button--primary" onClick={onSignIn}>
        Sign in with Microsoft
      </button>
      <p>This application is read-only.</p>
      <p>It uses your organization's Entra ID account.</p>
    </main>
  )
}
