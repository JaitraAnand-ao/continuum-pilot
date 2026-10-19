import { FOCUS } from '../session/controller'

export interface UnavailableScreenProps {
  traceId: string | null
  onTryAgain: () => void
}

/* /api/v1/me answered something other than 200, 401 or 403, or nothing at all. */
export function UnavailableScreen({ traceId, onTryAgain }: UnavailableScreenProps) {
  return (
    <main className="sign-in">
      <h1 id={FOCUS.unavailableHeading} tabIndex={-1}>
        Can't check your access right now
      </h1>
      <p>Nothing was changed. Try again in a moment.</p>
      {traceId !== null && (
        <p>
          Error reference <code>{traceId}</code>
        </p>
      )}
      <button type="button" className="button button--primary" onClick={onTryAgain}>
        Try again
      </button>
    </main>
  )
}
