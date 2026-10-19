import type { AppState, SessionActions } from './session/controller'
import { AppShell } from './screens/AppShell'
import { NoAccessScreen } from './screens/NoAccessScreen'
import { SignInFailedScreen } from './screens/SignInFailedScreen'
import { SignInScreen } from './screens/SignInScreen'
import { SigningInScreen } from './screens/SigningInScreen'
import { UnavailableScreen } from './screens/UnavailableScreen'

export function AppView({ state, actions }: { state: AppState; actions: SessionActions }) {
  switch (state.kind) {
    case 'checking':
      return <SigningInScreen />
    case 'signed-out':
      return <SignInScreen onSignIn={actions.signIn} />
    case 'denied':
      return (
        <NoAccessScreen
          message={state.message}
          onSignInWithDifferentAccount={() => void actions.signInWithDifferentAccount()}
          onSignOut={() => void actions.signOut()}
        />
      )
    case 'failed':
      return <SignInFailedScreen failure={state.failure} onTryAgain={actions.tryAgain} />
    case 'unavailable':
      return <UnavailableScreen onTryAgain={() => void actions.recheck()} />
    case 'signed-in':
      return (
        <AppShell
          me={state.me}
          screen={state.screen}
          warning={state.warning}
          onSignOut={() => void actions.signOut()}
          onStaySignedIn={() => void actions.staySignedIn()}
        />
      )
  }
}
