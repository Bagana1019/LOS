import { defineConfig } from 'vitest/config';
import { nestPreset } from '@los/config/vitest/nest.mjs';

export default defineConfig(nestPreset({ test: { setupFiles: ['./test/setup-env.ts'], include: ['test/**/*.test.ts', 'src/**/*.test.ts'] } }));
