import { APP_NAME, COPY } from '../copy'
import { FOCUS_IDS } from '../presentation'
import { StatusIcon } from './StatusIcon'

export function SignInScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="frame">
      <h1>{APP_NAME}</h1>
      <p className="notice">
        <StatusIcon kind="locked" />
        <span>{COPY.signIn.personalData}</span>
      </p>
      <button id={FOCUS_IDS.signInButton} type="button" className="button button--primary" onClick={onSignIn}>
        {COPY.signIn.button}
      </button>
      <p>{COPY.signIn.readOnly}</p>
      <p>{COPY.signIn.entraAccount}</p>
    </main>
  )
}
