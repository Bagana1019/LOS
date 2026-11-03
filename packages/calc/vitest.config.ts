import { defineConfig } from 'vitest/config';

// CLAUDE.md §2.2: @los/calc 100% coverage заавал. Модуль 0-д дараах файлууд зөвхөн `TODO` stub (throw) тул хасагдсан —
// тэдгээрийг хэрэгжүүлэх модуль өөрийн PR-д энэ жагсаалтаас файлаа УСТГАЖ, 100%-д хүргэнэ. (M7 schedule, M8 underwriting/sosco-score хэрэгжсэн.)
const STUBS_UNTIL_IMPLEMENTED: string[] = [];

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', ...STUBS_UNTIL_IMPLEMENTED],
      thresholds: { lines: 100 },
    },
  },
});
