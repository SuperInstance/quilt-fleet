/**
 * ════════════════════════════════════════════════════════════════════════════
 *  vitest.config.ts — test runner config
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  We use Vitest because it is the fastest way to run TS-native tests
 *  in this monorepo. The `globals: false` keeps imports explicit; the
 *  `pool: 'forks'` ensures each test file gets a fresh module graph
 *  (so timers / globals don't leak between tests).
 *  ──────────────────────────────────────────────────────────────────────────
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: ['default'],
  },
});
