import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createApi } from './api/client'
import { App } from './App'
import { browserClock, browserNavigator } from './browser'
import { SessionController } from './session/controller'

export function mount(element: HTMLElement): SessionController {
  const controller = new SessionController({
    api: createApi((input, init) => window.fetch(input, init)),
    clock: browserClock(window),
    navigator: browserNavigator(window),
  })
  window.addEventListener('popstate', () => void controller.syncFromLocation())
  createRoot(element).render(
    <StrictMode>
      <App controller={controller} doc={document} />
    </StrictMode>,
  )
  void controller.start()
  return controller
}
