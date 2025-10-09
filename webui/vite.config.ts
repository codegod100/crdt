import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      // Required for OPFS (Origin Private File System) support in SQLite WASM
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      // Proxy WebSocket connections to the Cloudflare Worker
      '/ws': {
        target: 'ws://localhost:8787',
        changeOrigin: true,
        ws: true,
      }
    },
    // Ensure headers are set for all responses
    middlewareMode: false,
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
})
