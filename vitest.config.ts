import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DESKTOP__: false },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
