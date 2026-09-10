import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const API_PORT = process.env.FOCUSDESK_PORT ?? '4317';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    // Talk to the local API without CORS or absolute URLs in the client.
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
