import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Nest DI нь decorator metadata шаарддаг — esbuild үүнийг гаргадаггүй тул SWC ашиглана.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
});
