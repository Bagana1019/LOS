// Audit seal (docs/DECISIONS.md 2026-11-19 · audit seal) — "origination".audit_log гинжийг шалгах / нэг удаа seal хийх. Build-ийн дараа:
//   pnpm --filter origination audit:verify [--anchor <seq>:<mac>]   — эвдэрсэн бол эхний холбоос, exit 1
//   pnpm --filter origination audit:seal
// DATABASE_URL, AUDIT_HMAC_KEY (+ AUDIT_HMAC_KEY_ID, AUDIT_HMAC_PREVIOUS_KEYS) шаардана. Түлхүүр, мөрийн агуулга хэвлэхгүй.
import { AUDIT_SEAL_COLUMNS, runAuditSealCli } from '@los/database';
import { PrismaClient } from '.prisma/client-origination';

if (require.main === module) {
  const db = new PrismaClient();
  runAuditSealCli(db, { schema: 'origination', columns: AUDIT_SEAL_COLUMNS }, process.argv.slice(2), (l) => process.stdout.write(`${l}\n`))
    .then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`audit-seal failed: ${e instanceof Error ? e.name : 'Error'}\n`); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
