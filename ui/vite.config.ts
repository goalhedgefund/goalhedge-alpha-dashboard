import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `D:\Claude\scalper` is a junction to the service directory. Vite resolves
// the config and HTML entry to their physical paths; make its root physical as
// well so Rollup never tries to emit index.html using a `../../...` filename.
const uiRoot = realpathSync(fileURLToPath(new URL('.', import.meta.url)));

// ⚠ The UI imports ONLY from core's protocol module (browser-safe: type-only
// domain imports + pure applyChanges). Importing core's index would drag
// better-sqlite3/ws/pino into the bundle. Keep every core import on @proto.
export default defineConfig({
  root: uiRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@proto': fileURLToPath(new URL('../core/src/gateway/protocol.ts', import.meta.url)),
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
