import { defineConfig } from 'vitest/config';

// CLAUDE.md §2.2: @los/calc 100% coverage заавал. Модуль 0-д дараах файлууд зөвхөн `TODO` stub (throw) тул хасагдсан —
// тэдгээрийг хэрэгжүүлэх модуль (M7 ЭТХ, M8 тооцоолол + Sosco) өөрийн PR-д энэ жагсаалтаас файлаа УСТГАЖ, 100%-д хүргэнэ.
const STUBS_UNTIL_IMPLEMENTED = ['src/schedule.ts', 'src/underwriting.ts', 'src/sosco-score.ts'];

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
