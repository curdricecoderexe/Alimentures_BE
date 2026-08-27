import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    testTimeout: 15000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['controllers/**', 'middlewares/**', 'utils/**', 'services/**', 'lib/**'],
      reporter: ['text', 'html'],
    },
  },
});
