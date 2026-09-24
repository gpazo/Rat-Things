import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native source checkouts under .runtime contain their own upstream tests.
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // Native suites create their own concurrent harnesses and subprocesses.
    // Bound suite concurrency without relaxing per-operation deadlines.
    maxWorkers: 1,
    // Several protocol tests mock Node built-ins; process isolation prevents
    // those module mocks from crossing file boundaries.
    pool: 'forks',
    isolate: true,
  },
});
