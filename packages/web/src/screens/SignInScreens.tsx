/* SCR-1: the Sign in screen and its states. Each heading or button carries the id the
 * controller moves focus to; announcements go through the shared live regions. */
import { COPY, FOCUS } from '../copy'
import { formatUtc, type CallbackError } from '../app/routes'
import { Icon } from './Icon'

export function SignInScreen({
  notice,
  onSignIn,
}: {
  notice?: 'signed-out' | 'expired' | undefined
  onSignIn: () => void
}) {
  return (
    <main className="sign-in">
      <h1>{COPY.signIn.heading}</h1>
      {notice && <p>{notice === 'signed-out' ? COPY.signIn.signedOut : COPY.signIn.expired}</p>}
      <button type="button" id={FOCUS.signInButton} onClick={onSignIn}>
        {COPY.signIn.button}
      </button>
      <section aria-labelledby="personal-data-label" className="notice">
        <Icon name="shield" />
        <h2 id="personal-data-label">{COPY.signIn.personalDataLabel}</h2>
        <p>{COPY.signIn.personalData}</p>
      </section>
      <p>{COPY.signIn.readOnly}</p>
      <p>{COPY.signIn.entraAccount}</p>
    </main>
  )
}

/** A plain load while the server answers: busy and silent, since nobody is being signed in yet. */
export function StartingScreen() {
  return <main className="sign-in" aria-busy="true" />
}

export function SigningInScreen() {
  return (
    <main className="sign-in" aria-busy="true">
      <h1 id={FOCUS.signingIn} tabIndex={-1}>
        {COPY.signingIn.heading}
      </h1>
      <p>{COPY.signingIn.detail}</p>
    </main>
  )
}

export function NoAccessScreen({
  title,
  onDifferentAccount,
  onSignOut,
}: {
  title: string
  onDifferentAccount: () => void
  onSignOut: () => void
}) {
  return (
    <main className="sign-in">
      <Icon name="blocked" />
      <h1 id={FOCUS.noAccess} tabIndex={-1}>
        {COPY.noAccess.heading}
      </h1>
      <p>{title}</p>
      <p>{COPY.noAccess.askAdministrator}</p>
      <button type="button" onClick={onDifferentAccount}>
        {COPY.noAccess.differentAccount}
      </button>
      <button type="button" onClick={onSignOut}>
        {COPY.noAccess.signOut}
      </button>
    </main>
  )
}

export function SignInErrorScreen({ error, onTryAgain }: { error: CallbackError; onTryAgain: () => void }) {
  return (
    <main className="sign-in">
      <Icon name="warning" />
      <h1 id={FOCUS.signInError} tabIndex={-1}>
        {COPY.signInError.heading}
      </h1>
      <p>{COPY.signInError.nothingChanged}</p>
      <dl>
        <dt>{COPY.signInError.code}</dt>
        <dd>
          <code>{error.code}</code>
        </dd>
        {error.reference && (
          <>
            <dt>{COPY.signInError.reference}</dt>
            <dd>
              <code>{error.reference}</code>
            </dd>
          </>
        )}
        {error.occurredAt && (
          <>
            <dt>{COPY.signInError.time}</dt>
            <dd>
              <code>{formatUtc(error.occurredAt)}</code>
            </dd>
          </>
        )}
      </dl>
      <button type="button" onClick={onTryAgain}>
        {COPY.signInError.tryAgain}
      </button>
    </main>
  )
}

export function UnavailableScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="sign-in">
      <Icon name="warning" />
      <h1 id={FOCUS.unavailable} tabIndex={-1}>
        {COPY.unavailable.heading}
      </h1>
      <p>{COPY.unavailable.detail}</p>
      <button type="button" onClick={onRetry}>
        {COPY.unavailable.tryAgain}
      </button>
    </main>
  )
}
