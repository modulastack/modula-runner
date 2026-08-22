import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/runner/test/runtime-red/**/*.runtime-red.ts'],
    maxWorkers: 1,
    testTimeout: 15_000,
  },
})
