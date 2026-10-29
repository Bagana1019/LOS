import { defineConfig } from 'vitest/config';
import { nestPreset } from '@los/config/vitest/nest.mjs';

// test/** = e2e (Module 0), src/** = нэгж + persistence тестүүд. DB-тэй тестүүд TEST_DATABASE_URL-гүй бол алгасагдана (docs/00-foundation.md §4).
export default defineConfig(
  nestPreset({
    test: {
      globalSetup: ['./test/global-setup.ts'],
      setupFiles: ['./test/setup-env.ts', './src/modules/merchant/testing/vitest.setup.ts'],
      include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.spec.ts'],
      coverage: {
        provider: 'v8',
        include: ['src/modules/merchant/**/*.ts'],
        exclude: ['src/modules/merchant/**/*.spec.ts', 'src/modules/merchant/**/*.test.ts', 'src/modules/merchant/testing/**', 'src/modules/merchant/persistence/**', 'src/modules/merchant/**/*.d.ts'],
        reporter: ['text-summary', 'text'],
      },
    },
  }),
);
