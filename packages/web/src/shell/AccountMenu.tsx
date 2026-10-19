import { useRef, useState } from 'react'
import { copy } from '../copy'

export interface AccountMenuProps {
  account: string
  displayName: string
  onSignOut: () => void
  defaultOpen?: boolean
}

/* Disclosure on the top bar holding the account and 'Sign out' (AC-9). */
export function AccountMenu({ account, displayName, onSignOut, defaultOpen = false }: AccountMenuProps) {
  const [open, setOpen] = useState(defaultOpen)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <div
      className="account-menu"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        setOpen(false)
        trigger.current?.focus()
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="account-menu__trigger"
        aria-expanded={open}
        aria-controls="account-menu-panel"
        aria-label={`${copy.shell.accountMenu}, ${account}`}
        onClick={() => setOpen(!open)}
      >
        {account}
      </button>
      <div id="account-menu-panel" className="account-menu__panel" hidden={!open}>
        <p>{displayName}</p>
        <button type="button" className="button" onClick={onSignOut}>
          {copy.shell.signOut}
        </button>
      </div>
    </div>
  )
}
