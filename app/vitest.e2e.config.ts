import { defineConfig } from 'vitest/config'

// §15 e2e: real Electron + real backend per test — sequential, long timeouts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
