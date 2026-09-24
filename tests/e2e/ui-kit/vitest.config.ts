// Node-environment unit checks for the UI kit (see kit.vitest.ts).
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  resolve: { alias: { '@': fileURLToPath(new URL('../../../src', import.meta.url)) } },
  test: {
    include: ['tests/e2e/ui-kit/**/*.vitest.ts'],
    environment: 'node',
  },
});
