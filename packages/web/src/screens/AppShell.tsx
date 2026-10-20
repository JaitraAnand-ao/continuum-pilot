import type { MouseEvent } from 'react'
import type { Me } from '../api/client'
import { FOCUS } from '../session/controller'
import { isReader, navigationFor, roleNames } from '../session/roles'
import { pageFor } from '../session/routes'

export interface AppShellProps {
  me: Me
  path: string
  signOutFailed: boolean
  onNavigate: (path: string) => void
  onSignOut: () => void
}

/* The signed-in frame: top bar, side navigation by role, and the page heading that takes focus. */
export function AppShell({ me, path, signOutFailed, onNavigate, onSignOut }: AppShellProps) {
  const page = pageFor(path)
  const allowed = !page.requiresReader || isReader(me.roles)
  const follow = (target: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    onNavigate(target)
  }
  return (
    <div className="shell">
      <header className="top-bar">
        <span className="top-bar__product">Entra Sign-In Reports</span>
        <p className="top-bar__roles">{roleNames(me.roles).join(' · ')}</p>
        <details className="account-menu">
          <summary>{me.account}</summary>
          <div className="account-menu__panel">
            <p>{me.displayName}</p>
            <button type="button" className="button" onClick={onSignOut}>
              Sign out
            </button>
            {signOutFailed && <p className="error">Sign-out didn't complete. Try again.</p>}
          </div>
        </details>
      </header>
      <nav aria-label="Main" className="side-nav">
        {navigationFor(me.roles).map((group) => (
          <section key={group.label} aria-labelledby={`nav-${group.label}`}>
            <h2 id={`nav-${group.label}`}>{group.label}</h2>
            <ul>
              {group.items.map((item) => (
                <li key={item.path}>
                  <a
                    href={item.path}
                    aria-current={item.path === path ? 'page' : undefined}
                    onClick={follow(item.path)}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
      <main className="page">
        <h1 id={FOCUS.pageHeading} tabIndex={-1}>
          {allowed ? page.heading : "This page isn't available"}
        </h1>
      </main>
    </div>
  )
}
