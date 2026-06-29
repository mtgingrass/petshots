import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js references Node's `global`, which doesn't exist
  // in the browser. Alias it to globalThis so the bundle runs client-side.
  define: {
    global: 'globalThis',
  },
})
