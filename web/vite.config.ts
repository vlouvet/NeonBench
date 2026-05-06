import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two supported dev workflows:
//
//   1. Run Go server with `--port 7373 --no-open`, then `npm run dev` (Vite at :5173).
//      Open http://localhost:5173 — Vite proxies /api requests to the Go server.
//      Best for fastest HMR.
//
//   2. Run Go server with `--dev` (any port), then `npm run dev`.
//      Open the Go server URL — Go reverse-proxies HTML/asset requests to Vite.
//      Useful when you want the same URL as production.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7373',
    },
  },
});
