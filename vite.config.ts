import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base works both at a domain root and under GitHub Pages project paths.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  preview: { host: '0.0.0.0', allowedHosts: true },
  server: { host: '0.0.0.0', allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentMatchGlobs: [['src/audio/*.test.ts', 'node']],
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 30_000,
  },
});
