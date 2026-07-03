import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext'
import { applyTheme, getSavedTheme } from './utils/theme'

// Apply saved theme before first paint to avoid flash.
applyTheme(getSavedTheme());

// BrowserRouter gives clean URLs (/dashboard, not /#/dashboard). CloudFront is
// already configured to rewrite 403/404 -> /index.html, so deep links work.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
