import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { nestPreset } from '@los/config/vitest/nest.mjs';

const config = nestPreset({ test: { globalSetup: ['./test/global-setup.ts'], setupFiles: ['./test/setup-env.ts'], include: ['test/**/*.test.ts', 'src/**/*.test.ts'] } });
// test/merchant-pos.e2e.test.ts boots the origination MerchantModule as the real upstream; its Prisma client lives in apps/origination.
config.resolve.alias.unshift({ find: /^\.prisma\/client-origination$/, replacement: resolve(__dirname, '../origination/node_modules/.prisma/client-origination') });

export default defineConfig(config);
