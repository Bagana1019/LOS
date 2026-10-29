import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { nestPreset } from '@los/config/vitest/nest.mjs';

// Workspace багцуудыг (dist-гүйгээр) эх кодоор нь уншина — unit тест build-ээс хамаарахгүй.
const pkg = (name: string) => fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));
const alias = ['calc', 'contracts', 'ocr', 'database'].map((name) => ({ find: new RegExp(`^@los/${name}$`), replacement: pkg(name) }));

export default defineConfig(
  nestPreset({
    resolve: { alias },
    test: { globalSetup: ['./test/global-setup.ts'], setupFiles: ['./test/setup-env.ts'], include: ['test/**/*.test.ts', 'src/**/*.test.ts'] },
  }),
);
