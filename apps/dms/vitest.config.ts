import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Workspace багцуудыг (dist-гүйгээр) эх кодоор нь уншина — тест build-ээс хамаарахгүй.
const pkg = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: { alias: { '@los/contracts': pkg('contracts'), '@los/ocr': pkg('ocr'), '@los/database': pkg('database') } },
  test: { include: ['src/**/*.test.ts'], setupFiles: ['./vitest.setup.ts'] },
});
