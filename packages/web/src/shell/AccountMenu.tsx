import { useRef, useState } from 'react'
import { copy } from '../copy'

export interface AccountMenuProps {
  account: string
  displayName: string
  onSignOut: () => void
  defaultOpen?: boolean
}

/* Escape on the open menu closes it and returns focus to its trigger; anything else is left alone. */
export function handleMenuKey(key: string, open: boolean, close: () => void, refocus: () => void): void {
  if (key !== 'Escape' || !open) return
  close()
  refocus()
}

/* Disclosure on the top bar holding the account and 'Sign out' (AC-9). */
export function AccountMenu({ account, displayName, onSignOut, defaultOpen = false }: AccountMenuProps) {
  const [open, setOpen] = useState(defaultOpen)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <div
      className="account-menu"
      onKeyDown={(event) =>
        handleMenuKey(
          event.key,
          open,
          () => setOpen(false),
          () => trigger.current?.focus(),
        )
      }
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
