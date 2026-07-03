import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// ⚠ The UI imports ONLY from core's protocol module (browser-safe: type-only
// domain imports + pure applyChanges). Importing core's index would drag
// better-sqlite3/ws/pino into the bundle. Keep every core import on @proto.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@proto': fileURLToPath(new URL('../core/src/gateway/protocol.ts', import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
