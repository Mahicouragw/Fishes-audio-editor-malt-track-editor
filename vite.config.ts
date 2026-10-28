import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The commit the bundle was built from, shown in the UI. A stale service-worker
 * or HTTP cache is indistinguishable from a broken feature when the only
 * difference is an invisible bundle hash, so the running build is visible.
 */
function resolveBuildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
  }
}
const BUILD_ID = resolveBuildId();

export default defineConfig({
  // Relative base works both at a domain root and under GitHub Pages project paths.
  base: './',
  plugins: [react()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
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
