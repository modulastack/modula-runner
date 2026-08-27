import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/runner/test/blackbox/**/*.blackbox.ts'],
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
})
