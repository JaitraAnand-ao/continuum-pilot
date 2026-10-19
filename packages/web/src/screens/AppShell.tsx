/* The signed-in frame: top bar naming the account and its roles, the side navigation the
 * roles allow, and the page heading the controller focuses on arrival. Report content
 * belongs to the report stories; this story only lands on the page. The account menu is a
 * platform popover: its button opens and closes it, Escape or a click outside closes it and
 * focus goes back to the button; opening it puts focus on 'Sign out'. */
import { useRef, useState, type MouseEvent } from 'react'
import type { Me } from '../api/client'
import { navigationFor, roleNames } from '../auth/roles'
import { APP_NAME, COPY, FOCUS } from '../copy'
import { ROUTE_LABELS, type ReportRoute } from '../app/routes'

export function AppShell({
  me,
  route,
  onNavigate,
  onSignOut,
}: {
  me: Me
  route: ReportRoute | 'none'
  onNavigate: (route: ReportRoute) => void
  onSignOut: () => void
}) {
  const groups = navigationFor(me.roles)
  const [menuOpen, setMenuOpen] = useState(false)
  const signOutButton = useRef<HTMLButtonElement>(null)
  const follow = (target: ReportRoute) => (event: MouseEvent) => {
    event.preventDefault()
    onNavigate(target)
  }
  return (
    <div className="shell">
      <header className="top-bar">
        <span className="app-name">{APP_NAME}</span>
        <ul aria-label={COPY.shell.roles} className="roles">
          {roleNames(me.roles).map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <button
          type="button"
          id={FOCUS.accountMenuButton}
          popoverTarget={FOCUS.accountMenu}
          aria-controls={FOCUS.accountMenu}
          aria-expanded={menuOpen}
        >
          {COPY.shell.accountMenu}
        </button>
        <div
          id={FOCUS.accountMenu}
          popover="auto"
          className="account-menu"
          onToggle={(event) => {
            const open = event.newState === 'open'
            setMenuOpen(open)
            if (open) signOutButton.current?.focus()
          }}
        >
          <p>{me.account}</p>
          <button type="button" id={FOCUS.accountSignOut} ref={signOutButton} onClick={onSignOut}>
            {COPY.shell.signOut}
          </button>
        </div>
      </header>
      <div className="layout">
        {groups.length > 0 && (
          <nav aria-label={COPY.shell.navigation} className="side-nav">
            {groups.map((group) => (
              <section key={group.label} aria-labelledby={`nav-${group.label}`}>
                <h2 id={`nav-${group.label}`}>{group.label}</h2>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.route}>
                      <a
                        href={item.path}
                        aria-current={item.route === route ? 'page' : undefined}
                        onClick={follow(item.route)}
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
        )}
        <main className="content">
          <h1 id={FOCUS.main} tabIndex={-1}>
            {route === 'none' ? APP_NAME : ROUTE_LABELS[route]}
          </h1>
          {route === 'none' && <p>{COPY.shell.noReaderRole}</p>}
        </main>
      </div>
    </div>
  )
}
