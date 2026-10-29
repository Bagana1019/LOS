import { defineConfig } from 'vitest/config';

// Unit tests: цэвэр логик (format, error mapping, i18n, api client, status helpers, payload builders). Компонентуудыг (esign) react-dom/server-ээр render хийнэ, jsdom ашиглахгүй; интерактив урсгалыг Playwright e2e шалгана.
// `jsx: 'automatic'` — tsconfig-ийн `preserve` нь vite-д JSX-ийг хөрвүүлэхгүй тул, .tsx модулиас цэвэр функц импортлоход хэрэгтэй.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
});
