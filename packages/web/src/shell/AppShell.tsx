import type { Me } from '../api/client'
import { APP_NAME, copy } from '../copy'
import { DAILY_REPORT_PATH, navGroupsFor, roleNames } from '../session/roles'
import { AccountMenu } from './AccountMenu'
import { IdleWarningDialog } from './IdleWarningDialog'

export interface AppShellProps {
  me: Me
  page: 'daily' | 'home'
  idleWarning: boolean
  onStay: () => void
  onSignOut: () => void
  accountMenuOpen?: boolean
}

/* Top bar, side navigation from the /api/v1/me roles, and the landing heading (AC-2, AC-3).
 * The Daily report's figures are delivered by the report stories. */
export function AppShell({ me, page, idleWarning, onStay, onSignOut, accountMenuOpen = false }: AppShellProps) {
  const groups = navGroupsFor(me.roles)
  return (
    <>
      <div className="shell" inert={idleWarning}>
        <header className="topbar">
          <span className="topbar__name">{APP_NAME}</span>
          <p className="topbar__roles">
            {copy.shell.roles}: {roleNames(me.roles).join(', ')}
          </p>
          <AccountMenu
            account={me.account}
            displayName={me.displayName}
            onSignOut={onSignOut}
            defaultOpen={accountMenuOpen}
          />
        </header>
        {groups.length > 0 && (
          <nav className="sidenav" aria-label={copy.shell.navLabel}>
            {groups.map((group) => (
              <section key={group.label} aria-labelledby={`nav-${group.label}`}>
                <h2 id={`nav-${group.label}`}>{group.label}</h2>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <a href={item.href} aria-current={item.href === DAILY_REPORT_PATH ? 'page' : undefined}>
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
          <h1 id="page-heading" tabIndex={-1}>
            {page === 'daily' ? copy.shell.dailyReport : copy.shell.home}
          </h1>
        </main>
      </div>
      {idleWarning && <IdleWarningDialog onStay={onStay} onSignOut={onSignOut} />}
    </>
  )
}
