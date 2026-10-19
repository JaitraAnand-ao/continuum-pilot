import { createRoot } from 'react-dom/client'
import { App } from './App'
import { getMe, logout } from './api/client'
import { SessionController } from './session/controller'
import './styles.css'

const controller = new SessionController(
  { getMe: () => getMe(), logout: () => logout() },
  {
    pathname: () => window.location.pathname,
    search: () => window.location.search,
    assign: (url) => window.location.assign(url),
    replace: (path) => window.history.replaceState(null, '', path),
  },
  {
    now: () => Date.now(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  },
)

const root = document.getElementById('root')
if (root) createRoot(root).render(<App controller={controller} doc={document} />)
