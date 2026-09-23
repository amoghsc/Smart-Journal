import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App'
import { StoreProvider } from './lib/store'
import { UpdateBanner } from './components/UpdateBanner'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
      <UpdateBanner />
    </StoreProvider>
  </StrictMode>,
)
