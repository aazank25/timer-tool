/**
 * Loaded ahead of the server by `npm start` (node --import), so that config.ts, which reads
 * NODE_ENV once, sees production as it does in the desktop app. Without it a started server
 * would still trust the Vite dev server's origin (CORS and writes) on a computer where any other
 * project's dev server may be running on that port. `npm run dev` does not load it.
 */
process.env.NODE_ENV ??= 'production';
