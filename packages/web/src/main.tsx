import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createApi } from './api/client'
import { App } from './App'
import { browserClock, browserNavigator } from './browser'
import { followHistoryPage, HistoryController } from './history/controller'
import { SessionController } from './session/controller'

export function mount(element: HTMLElement): SessionController {
  const api = createApi((input, init) => window.fetch(input, init))
  const controller = new SessionController({
    api,
    clock: browserClock(window),
    navigator: browserNavigator(window),
  })
  const history = new HistoryController({
    api,
    session: { notify: controller.notify, recheck: controller.staySignedIn },
  })
  followHistoryPage(controller, history)
  window.addEventListener('popstate', () => void controller.syncFromLocation())
  createRoot(element).render(
    <StrictMode>
      <App controller={controller} history={history} doc={document} />
    </StrictMode>,
  )
  void controller.start()
  return controller
}
