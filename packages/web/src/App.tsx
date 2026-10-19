import { useEffect, useRef, useSyncExternalStore } from 'react'
import { AppView } from './AppView'
import { applyTitle, FocusManager, focusTargetFor, type FocusDocument } from './presentation'
import type { SessionController } from './session/controller'

export function App({ controller, doc }: { controller: SessionController; doc: FocusDocument }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const focus = useRef(new FocusManager())

  useEffect(() => {
    void controller.start()
    return () => controller.dispose()
  }, [controller])

  useEffect(() => {
    applyTitle(doc, state)
    focus.current.update(doc, focusTargetFor(state))
  }, [doc, state])

  return <AppView state={state} actions={controller} />
}
