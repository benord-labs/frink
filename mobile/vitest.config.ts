import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      zod: fileURLToPath(new URL('./node_modules/zod', import.meta.url)),
      '@frink/shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node', maxWorkers: 1 },
});
