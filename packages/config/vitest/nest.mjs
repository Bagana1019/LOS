// NestJS + vitest preset: esbuild decorator metadata (emitDecoratorMetadata) гаргадаггүй тул constructor injection
// ажиллахгүй. SWC-ээр metadata гаргуулна. Хэрэглээ (апп бүрийн vitest.config.ts):
//   import { defineConfig } from 'vitest/config';
//   import { nestPreset } from '@los/config/vitest/nest.mjs';
//   export default defineConfig(nestPreset({ test: { globalSetup: ['./test/global-setup.ts'] } }));
import { resolve } from 'node:path';
import swc from 'unplugin-swc';

export function nestPreset(config = {}) {
  return {
    ...config,
    // Vite `.prisma/client-<svc>` (апп-ын node_modules дахь Prisma output)-ийг харьцангуй зам гэж ойлгодог → абсолют руу чиглүүлнэ.
    resolve: { ...(config.resolve ?? {}), alias: [{ find: /^\.prisma\/(client-[\w-]+)$/, replacement: resolve(process.cwd(), 'node_modules/.prisma/$1') }, ...(Array.isArray(config.resolve?.alias) ? config.resolve.alias : [])] },
    plugins: [
      swc.vite({
        module: { type: 'es6' },
        jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } },
      }),
      ...(config.plugins ?? []),
    ],
    test: { environment: 'node', fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000, ...(config.test ?? {}) },
  };
}
