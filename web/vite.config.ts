import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const API_PORT = process.env.FOCUSDESK_PORT ?? '4317';
const here = fileURLToPath(new URL('.', import.meta.url));
const rootModules = fileURLToPath(new URL('../node_modules', import.meta.url));

/**
 * What Vite keeps back by default. A `deny` list of the config's own replaces that one rather than
 * adding to it, so it is repeated in ours, and a test holds it to what Vite really has.
 */
const VITE_DENY = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'];

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
    // there, and Vite hands out any file under a directory it may serve. The dependencies hold a
    // link back to the server's own folder (node_modules/@focusdesk/server), which makes that
    // folder reachable by that path as well, and a data folder given as a relative path is made in
    // it. So on top of what Vite refuses by default, a database is refused by name wherever it is,
    // and so is anything in a data folder of the server's. That one starts from the link and is not
    // a plain `**/data/**`: Vite matches the whole path of a file, so that would refuse every file
    // of a repo that is kept inside any folder called data.
    fs: {
      strict: true,
      allow: [here, rootModules],
      deny: [
        ...VITE_DENY,
        '**/@focusdesk/server/**/data/**',
        '**/*.sqlite',
        '**/*.sqlite-*',
        '**/*.db',
        '**/*.db-*',
      ],
    },
    // Talk to the local API without CORS or absolute URLs in the client. The Host the browser used
    // goes through as it is, so the API's check of it still has something to look at.
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}` } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
