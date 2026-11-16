import { Agent } from 'node:http'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The browser calls the API at /api on the web app's own address, as it does behind nginx in Docker
// (frontend/nginx.conf). In `npm run dev` Vite forwards /api to the local API on :8010.
const API = 'http://127.0.0.1:8010'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        // A new connection per request. Node 22 reuses proxy connections; one dropped when the browser cancels a
        // request (React runs effects twice in development) was reused, and the next /all-slabs hung until the timeout.
        agent: new Agent({ keepAlive: false }),
        rewrite: (path) => path.replace(/^\/api/, ''),
        // A cold API builds its views for about a minute.
        timeout: 600_000,
        proxyTimeout: 600_000,
      },
    },
  },
})
