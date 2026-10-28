import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// turbo 2 strict env mode: globalEnv/env-д жагсаалгүй хувьсагчийг `turbo run` task-д дамжуулдаггүй. Эдгээрийн аль нэг нь алга бол kyc
// `pnpm dev` / `turbo run` дор тохиргоогоо хараагүй ажиллана (ялангуяа NODE_ENV=production үед INTEGRATION_MODE-ийн хамгаалалт).
const REQUIRED = ['NODE_ENV', 'INTEGRATION_MODE', 'DEFAULT_ORG_ID', 'AML_LIST_REFRESH_MINUTES', 'DATABASE_URL'];

describe('turbo.json globalEnv [20]', () => {
  const turbo = JSON.parse(readFileSync(resolve(__dirname, '../../../../../turbo.json'), 'utf8')) as { globalEnv?: string[]; globalPassThroughEnv?: string[] };

  it.each(REQUIRED)('passes %s through to tasks', (name) => {
    expect([...(turbo.globalEnv ?? []), ...(turbo.globalPassThroughEnv ?? [])]).toContain(name);
  });
});
