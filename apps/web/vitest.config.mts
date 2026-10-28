import { defineConfig } from 'vitest/config';

// Playwright (e2e/) өөрийн runner-тэй — vitest-д оруулахгүй.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['e2e/**', 'node_modules/**', '.next/**'] } });
