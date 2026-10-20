import { useEffect, useSyncExternalStore } from 'react'
import type { HistoryController } from './history/controller'
import type { SessionController, ViewState } from './session/controller'
import { View } from './screens/View'

export interface FocusableDocument {
  title: string
  getElementById(id: string): { focus(): void } | null
}

/* Route titles and focus moves (focus-and-announcements): runs after each render that asked for them. */
export function applyView(doc: FocusableDocument, state: Pick<ViewState, 'title' | 'focus'>): void {
  doc.title = state.title
  if (state.focus !== null) doc.getElementById(state.focus)?.focus()
}

export interface AppProps {
  controller: SessionController
  history: HistoryController
  doc: FocusableDocument
}

export function App({ controller, history, doc }: AppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const historyState = useSyncExternalStore(history.subscribe, history.getState, history.getState)
  useEffect(() => applyView(doc, state), [doc, state.title, state.focusRequest])
  return <View state={state} actions={controller} history={{ state: historyState, actions: history }} />
}
