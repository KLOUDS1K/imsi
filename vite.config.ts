import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['libraw-wasm'] },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    // Public source maps expose the complete editor implementation and are not
    // consumed by an error-reporting service in production.
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { index: resolve(import.meta.dirname, 'index.html') },
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/media': 'http://127.0.0.1:8787',
      '/download': 'http://127.0.0.1:8787',
    },
  },
  preview: { host: true, port: 4173 },
});
