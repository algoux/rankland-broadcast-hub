import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@server/modules/live-contest/live-contest.service',
        replacement: path.resolve(__dirname, 'tests/fixtures/live-contest-service.ts'),
      },
      {
        find: '@common',
        replacement: path.resolve(__dirname, 'src/common'),
      },
      {
        find: '@server',
        replacement: path.resolve(__dirname, 'src/server'),
      },
    ],
  },
  test: {
    environment: 'node',
    globals: true,
  },
});
