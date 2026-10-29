// Gateway-ийн e2e тест бодит Postgres-тэй (TEST_DATABASE_URL, `iam` schema). Тохируулаагүй бол тестүүд алгасагдана.
import { resolve } from 'node:path';
import { prepareTestDb } from '@los/config/vitest/test-db.mjs';

export { TEST_SEED_PASSWORD } from '@los/config/vitest/test-db.mjs';
export default function setup(): void {
  prepareTestDb({ service: 'gateway', schema: 'iam', cwd: resolve(__dirname, '..') });
}
