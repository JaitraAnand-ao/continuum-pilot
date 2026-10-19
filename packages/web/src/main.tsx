/* Browser wiring: binds the controller's ports to the real window and renders its state.
 * Behaviour lives in the controller and the screens; main.test.ts drives this wiring in a
 * real document for every ST-1 trigger. */
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createApiClient } from './api/client'
import { createAnnouncer } from './a11y/announcer'
import { focusById } from './a11y/focus'
import { SessionController } from './app/controller'
import { AppView, type Actions } from './screens/AppView'
import './styles/app.css'

function App({ controller, actions }: { controller: SessionController; actions: Actions }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  return <AppView state={state} actions={actions} />
}

export function mount(container: HTMLElement, win: Window = window): () => void {
  const doc = win.document
  const announcer = createAnnouncer(doc)
  const controller = new SessionController({
    api: createApiClient((url, init) => win.fetch(url, init)),
    now: () => Date.now(),
    setTimer: (fn, ms) => win.setTimeout(fn, ms),
    clearTimer: (handle) => win.clearTimeout(handle as number),
    redirect: (url) => win.location.assign(url),
    pushUrl: (path) => win.history.pushState(null, '', path),
    replaceUrl: (path) => win.history.replaceState(null, '', path),
    setTitle: (title) => (doc.title = title),
    /* After React has committed the screen the focus target belongs to. */
    focus: (id) => win.requestAnimationFrame(() => focusById(doc, id)),
    announce: (text, politeness) => announcer.announce(text, politeness),
  })
  const actions: Actions = {
    signIn: () => controller.signIn(),
    signOut: () => void controller.signOut(),
    signInWithDifferentAccount: () => void controller.signInWithDifferentAccount(),
    retry: () => void controller.retry(),
    navigate: (route) => void controller.navigate(route),
    staySignedIn: () => void controller.staySignedIn(),
  }
  const onPopState = () => void controller.restore(win.location)
  win.addEventListener('popstate', onPopState)
  const root = createRoot(container)
  root.render(<App controller={controller} actions={actions} />)
  void controller.start(win.location)
  return () => {
    win.removeEventListener('popstate', onPopState)
    controller.dispose()
    root.unmount()
  }
}
