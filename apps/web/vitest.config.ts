import { defineConfig } from 'vitest/config';

// node орчин (jsdom суугаагүй): tsx компонентыг react-dom/server-ээр render хийнэ.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
