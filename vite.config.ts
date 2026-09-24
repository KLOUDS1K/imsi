import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// base: './' keeps the build relocatable, so the dist/ folder can be dropped
// under any sub-path of kloud.photography (e.g. /editor/) without rewrites.
export default defineConfig({
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['libraw-wasm'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
