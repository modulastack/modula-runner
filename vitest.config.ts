import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    maxWorkers: 1,
    testTimeout: 15_000,
  },
})
