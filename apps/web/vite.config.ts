import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@big-upload/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@big-upload/upload-core': fileURLToPath(new URL('../../packages/upload-core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:3000', changeOrigin: true } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './test/setup.ts',
  },
});
