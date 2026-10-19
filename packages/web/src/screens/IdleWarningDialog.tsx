/* AC-9: the idle warning, on the platform's modal <dialog>: showModal() puts it in the top
 * layer with the page behind inert, focuses 'Stay signed in' (its first button), and close()
 * gives focus back to where it was. Tab is kept inside it. It is a plain dialog named by its
 * title: the controller speaks the warning once, through the shared assertive region, so
 * neither an alertdialog role nor aria-describedby repeats it. Escape keeps me signed in. */
import { useLayoutEffect, useRef } from 'react'
import { containTab } from '../a11y/focus'
import { COPY, FOCUS } from '../copy'
import { formatUtcTime } from '../app/routes'
import { Icon } from './Icon'

export function IdleWarningDialog({
  idleExpiresAt,
  onStay,
  onSignOut,
}: {
  idleExpiresAt: string
  onStay: () => void
  onSignOut: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      aria-labelledby="idle-warning-title"
      className="dialog"
      onCancel={(event) => {
        event.preventDefault()
        onStay()
      }}
      onKeyDown={(event) => containTab(event.nativeEvent, event.currentTarget)}
    >
      <Icon name="clock" />
      <h2 id="idle-warning-title">{COPY.idle.title}</h2>
      <p>{COPY.idle.body(formatUtcTime(idleExpiresAt))}</p>
      <div className="actions">
        <button type="button" id={FOCUS.staySignedIn} onClick={onStay}>
          {COPY.idle.stay}
        </button>
        <button type="button" id={FOCUS.idleSignOut} onClick={onSignOut}>
          {COPY.idle.signOut}
        </button>
      </div>
    </dialog>
  )
}
