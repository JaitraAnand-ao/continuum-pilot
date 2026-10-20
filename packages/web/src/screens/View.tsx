import type { SessionController, ViewState } from '../session/controller'
import { AppShell } from './AppShell'
import { CheckingScreen } from './CheckingScreen'
import { IdleWarningDialog } from './IdleWarningDialog'
import { LiveRegion } from './LiveRegion'
import { NoAccessScreen } from './NoAccessScreen'
import { SignInFailedScreen } from './SignInFailedScreen'
import { SignInScreen } from './SignInScreen'
import { UnavailableScreen } from './UnavailableScreen'

export type Actions = Pick<
  SessionController,
  'start' | 'signIn' | 'navigate' | 'staySignedIn' | 'signOut' | 'signInWithDifferentAccount'
>

function ScreenFor({ state, actions }: { state: ViewState; actions: Actions }) {
  const { screen } = state
  switch (screen.name) {
    case 'checking':
      return <CheckingScreen />
    case 'signIn':
      return <SignInScreen notice={screen.notice} onSignIn={actions.signIn} />
    case 'denied':
      return (
        <NoAccessScreen
          message={screen.message}
          signOutFailed={state.signOutFailed}
          onSignInWithDifferentAccount={() => void actions.signInWithDifferentAccount()}
          onSignOut={() => void actions.signOut()}
        />
      )
    case 'failed':
      return <SignInFailedScreen failure={screen.failure} onTryAgain={actions.signIn} />
    case 'unavailable':
      return <UnavailableScreen traceId={screen.traceId} onTryAgain={() => void actions.start()} />
    case 'app':
      return (
        <>
          <AppShell
            me={screen.me}
            path={screen.path}
            signOutFailed={state.signOutFailed}
            onNavigate={(path) => void actions.navigate(path)}
            onSignOut={() => void actions.signOut()}
          />
          {state.idleWarning && (
            <IdleWarningDialog
              onStaySignedIn={() => void actions.staySignedIn()}
              onSignOut={() => void actions.signOut()}
            />
          )}
        </>
      )
  }
}

export function View({ state, actions }: { state: ViewState; actions: Actions }) {
  return (
    <>
      <ScreenFor state={state} actions={actions} />
      <LiveRegion announcement={state.announcement} />
    </>
  )
}
