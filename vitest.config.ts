import { defineConfig } from 'vitest/config'
import path from 'path'

// Minimal vitest setup. Runs Node-environment tests in `tests/**`
// against the Next route handlers directly. Browser/RTL tests live
// in Playwright (e2e/smoke) and aren't picked up here.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
})
