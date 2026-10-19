/* Renders the controller's state; holds no state or rules of its own. */
import type { Screen } from '../app/controller'
import type { ReportRoute } from '../app/routes'
import { AppShell } from './AppShell'
import { IdleWarningDialog } from './IdleWarningDialog'
import {
  NoAccessScreen,
  SignInErrorScreen,
  SignInScreen,
  SigningInScreen,
  StartingScreen,
  UnavailableScreen,
} from './SignInScreens'

export type Actions = {
  signIn: () => void
  signOut: () => void
  signInWithDifferentAccount: () => void
  retry: () => void
  navigate: (route: ReportRoute) => void
  staySignedIn: () => void
}

export function AppView({ state, actions }: { state: Screen; actions: Actions }) {
  switch (state.kind) {
    case 'starting':
      return <StartingScreen />
    case 'checking':
      return <SigningInScreen />
    case 'sign-in':
      return <SignInScreen notice={state.notice} onSignIn={actions.signIn} />
    case 'sign-in-error':
      return <SignInErrorScreen error={state.error} onTryAgain={actions.signIn} />
    case 'no-access':
      return (
        <NoAccessScreen
          title={state.title}
          onDifferentAccount={actions.signInWithDifferentAccount}
          onSignOut={actions.signOut}
        />
      )
    case 'unavailable':
      return <UnavailableScreen onRetry={actions.retry} />
    case 'app':
      return (
        <>
          <AppShell me={state.me} route={state.route} onNavigate={actions.navigate} onSignOut={actions.signOut} />
          {state.idleWarning && (
            <IdleWarningDialog
              idleExpiresAt={state.me.idleExpiresAt}
              onStay={actions.staySignedIn}
              onSignOut={actions.signOut}
            />
          )}
        </>
      )
  }
}
