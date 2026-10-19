import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createBrowserPorts, type BrowserWindow } from './browser'
import { createSessionController } from './session/controller'

/* Boots the SPA into a real document: browser ports, the session controller and the React root. */
export function mount(container: Element, win: BrowserWindow = window): Promise<void> {
  const controller = createSessionController(createBrowserPorts(win))
  createRoot(container).render(<App controller={controller} />)
  return controller.start()
}
