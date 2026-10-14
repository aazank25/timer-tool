import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const API_PORT = process.env.FOCUSDESK_PORT ?? '4317';
const here = fileURLToPath(new URL('.', import.meta.url));
const rootModules = fileURLToPath(new URL('../node_modules', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    // The API trusts writes from this exact origin while developing (config.devOrigins), so the
    // dev server never wanders to another port.
    strictPort: true,
    // The page talks to the API through the proxy below, from its own origin, so no other page
    // has a reason to read from this server. Vite's default answers a page on any localhost port.
    cors: false,
    // The API tells the browser its pages are not to be framed; the pages Vite serves have to say
    // the same, or the app can still be shown in a frame while developing.
    headers: {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    },
    // Serve this package and the hoisted dependencies, not the repo root: the database is data/
    // there, and Vite hands out any file under a directory it may serve.
    fs: { strict: true, allow: [here, rootModules] },
    // Talk to the local API without CORS or absolute URLs in the client. The Host the browser used
    // goes through as it is, so the API's check of it still has something to look at.
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}` } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
