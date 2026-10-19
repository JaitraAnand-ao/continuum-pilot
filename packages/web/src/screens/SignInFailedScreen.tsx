import type { SignInFailure } from '../session/callback'
import { FOCUS } from '../session/controller'

export interface SignInFailedScreenProps {
  failure: SignInFailure
  onTryAgain: () => void
}

/* SCR-1, Microsoft returned an error to the callback (AC-6). */
export function SignInFailedScreen({ failure, onTryAgain }: SignInFailedScreenProps) {
  return (
    <main className="sign-in">
      <h1 id={FOCUS.failedHeading} tabIndex={-1}>
        Sign-in didn't complete
      </h1>
      <p>
        Microsoft Entra ID returned error <code>{failure.code}</code>.
      </p>
      <p>Nothing was changed.</p>
      <dl>
        <dt>Error reference</dt>
        <dd>
          <code>{failure.reference ?? 'Not provided'}</code>
        </dd>
        <dt>Time (UTC)</dt>
        <dd>
          <code>{failure.occurredAt ?? 'Not provided'}</code>
        </dd>
      </dl>
      <button type="button" className="button button--primary" onClick={onTryAgain}>
        Try again
      </button>
    </main>
  )
}
