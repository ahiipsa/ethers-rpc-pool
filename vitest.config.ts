import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: './vitest.setup.ts',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/sandbox.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 98,
        functions: 100,
        branches: 90,
        statements: 97,
      },
    },
  },
});
