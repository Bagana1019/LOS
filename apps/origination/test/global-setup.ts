import { resolve } from 'node:path';
import { prepareTestDb } from '@los/config/vitest/test-db.mjs';

export default function setup(): void {
  prepareTestDb({ service: 'origination', cwd: resolve(__dirname, '..') });
}
