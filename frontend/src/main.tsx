import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthGate } from './auth.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
// Fonts are bundled: the server's CSP allows fonts from this site only.
import '@fontsource/poppins/400.css'
import '@fontsource/poppins/500.css'
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import './brand.css'
import { applyTheme, initialTheme } from './theme.ts'

applyTheme(initialTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary whole>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
)
