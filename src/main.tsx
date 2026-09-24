import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App'
import { StoreProvider } from './lib/store'
import { UpdateBanner } from './components/UpdateBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { watchGlobalErrors } from './lib/errors'

watchGlobalErrors()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      <UpdateBanner />
    </StoreProvider>
  </StrictMode>,
)
