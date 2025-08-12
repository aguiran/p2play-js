import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'src/events/**/*.ts',
        'src/sync/**/*.ts',
        'src/game/MovementSystem.ts',
        'src/net/serialization.ts'
      ],
      exclude: ['src/index.ts'],
    },
    include: ['test/**/*.test.ts']
  }
});


