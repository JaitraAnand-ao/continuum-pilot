/* Test support: what the browser tests load. It exposes the real mount() and a way to
 * render any controller state with recording actions, so a test can drive one screen. */
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { Screen } from '../app/controller'
import { AppView, type Actions } from '../screens/AppView'
import '../styles/app.css'

export { mount } from '../main'

/** Renders `state` into `container`; the returned list records each action taken, in order. */
export function renderState(container: HTMLElement, state: Screen): { calls: string[]; rerender(next: Screen): void } {
  const calls: string[] = []
  const record = (name: keyof Actions) => () => void calls.push(name)
  const actions: Actions = {
    signIn: record('signIn'),
    signOut: record('signOut'),
    signInWithDifferentAccount: record('signInWithDifferentAccount'),
    retry: record('retry'),
    navigate: record('navigate'),
    staySignedIn: record('staySignedIn'),
  }
  const root = createRoot(container)
  const rerender = (next: Screen) => flushSync(() => root.render(<AppView state={next} actions={actions} />))
  rerender(state)
  return { calls, rerender }
}
