import { APP_NAME, COPY } from '../copy'
import { FOCUS_IDS } from '../presentation'
import type { Me } from '../api/client'
import { navGroups, roleLabels, SCREENS, type ScreenId } from '../session/roles'
import { IdleWarningDialog } from './IdleWarningDialog'

/* The signed-in frame: top bar naming the account and its roles, the side navigation the roles
 * allow, and the current screen's heading. Report content arrives with the report stories. */
export function AppShell({
  me,
  screen,
  warning,
  onSignOut,
  onStaySignedIn,
}: {
  me: Me
  screen: ScreenId
  warning: boolean
  onSignOut: () => void
  onStaySignedIn: () => void
}) {
  return (
    <>
      <div className="shell" inert={warning}>
        <header className="top-bar">
          <span className="app-name">{APP_NAME}</span>
          <p className="account">
            {COPY.shell.signedInAs} <span>{me.account}</span>
          </p>
          <p className="roles">
            {COPY.shell.roles}: {roleLabels(me.roles).join(', ')}
          </p>
          <details className="account-menu">
            <summary>{COPY.shell.accountMenu}</summary>
            <button type="button" className="button" onClick={onSignOut}>
              {COPY.shell.signOut}
            </button>
          </details>
        </header>
        {navGroups(me.roles).map((group) => (
          <nav key={group.label} className="side-nav" aria-labelledby={`nav-${group.label}`}>
            <h2 id={`nav-${group.label}`}>{group.label}</h2>
            <ul>
              {group.items.map((item) => (
                <li key={item.screen}>
                  <a href={item.href} aria-current={item.screen === screen ? 'page' : undefined}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
        <main className="content">
          <h1 id={FOCUS_IDS.screenHeading} tabIndex={-1}>
            {SCREENS[screen].heading}
          </h1>
        </main>
      </div>
      {warning && (
        <IdleWarningDialog idleExpiresAt={me.idleExpiresAt} onStaySignedIn={onStaySignedIn} onSignOut={onSignOut} />
      )}
    </>
  )
}
