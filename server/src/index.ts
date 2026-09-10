import { startServer } from './app.js';

const running = await startServer();

console.log(`[focusdesk] api ready at ${running.url}/api`);
console.log(
  running.hasWebBuild
    ? `[focusdesk] open ${running.url}`
    : '[focusdesk] no web build found — run `npm run dev` for the UI, or `npm run build` first',
);
console.log(`[focusdesk] data: ${running.dataDir}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
