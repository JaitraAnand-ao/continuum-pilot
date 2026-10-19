import { useSyncExternalStore } from 'react'
import { LiveRegions } from './LiveRegions'
import { CheckingScreen } from './screens/CheckingScreen'
import { NoAccessScreen } from './screens/NoAccessScreen'
import { SignInFailedScreen } from './screens/SignInFailedScreen'
import { SignInScreen } from './screens/SignInScreen'
import { UnavailableScreen } from './screens/UnavailableScreen'
import type { SessionController, View } from './session/controller'
import { AppShell } from './shell/AppShell'

export function Screen({ view, controller }: { view: View; controller: SessionController }) {
  switch (view.kind) {
    case 'loading':
      return <main aria-busy="true" />
    case 'signIn':
      return <SignInScreen notice={view.notice} onSignIn={controller.signIn} />
    case 'checking':
      return <CheckingScreen />
    case 'signInFailed':
      return (
        <SignInFailedScreen
          code={view.code}
          reference={view.reference}
          timestamp={view.timestamp}
          onTryAgain={controller.tryAgain}
        />
      )
    case 'noAccess':
      return (
        <NoAccessScreen
          message={view.message}
          onDifferentAccount={controller.signInWithDifferentAccount}
          onSignOut={() => void controller.signOut()}
        />
      )
    case 'unavailable':
      return <UnavailableScreen onTryAgain={() => void controller.recheck()} />
    case 'dashboard':
      return (
        <AppShell
          me={view.me}
          page={view.page}
          idleWarning={view.idleWarning}
          onStay={() => void controller.staySignedIn()}
          onSignOut={() => void controller.signOut()}
        />
      )
  }
}

export function App({ controller }: { controller: SessionController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  return (
    <>
      <LiveRegions announcement={state.announcement} />
      <Screen view={state.view} controller={controller} />
    </>
  )
}
