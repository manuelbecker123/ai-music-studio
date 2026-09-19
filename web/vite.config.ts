import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the app calls /api on the Vite server, which forwards it to the Python
// server. In production the Python server serves the built app itself, so /api is same-origin.
const api = process.env.API_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': api } },
})
