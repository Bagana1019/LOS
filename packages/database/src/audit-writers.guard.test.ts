// Audit seal (DECISIONS 2026-11-19): `audit_log` / `audit_seal` руу бичих ЦОРЫН ГАНЦ зам нь энэ багцын helper-ууд.
// Шинэ код шууд `auditLog.create(...)`, `INSERT INTO ... audit_log` бичвэл энэ тест УНАНА.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../..');
/** Бичих эрхтэй файлууд (repo-оос харьцангуй). */
const ALLOWED = new Set(['packages/database/src/audit.ts', 'packages/database/src/audit-seal.ts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'test', 'e2e', 'testing', '__fixtures__']);
const isTestFile = (f: string) => /\.(test|spec|e2e)\.tsx?$/.test(f) || /(^|\/)test-[\w-]+\.ts$/.test(f);

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'prisma delegate write', re: /\baudit(Log|Seal)\s*\.\s*(create|createMany|createManyAndReturn|upsert|update|updateMany|delete|deleteMany)\s*\(/ },
  { name: 'bracket delegate access', re: /\[\s*['"`]audit(Log|Seal)['"`]\s*\]/ },
  { name: 'raw SQL write', re: /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+[^;]*?\baudit_(log|seal)\b/i },
];

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p, out); continue; }
    if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name) && !name.endsWith('.d.ts') && !isTestFile(name)) out.push(p);
  }
  return out;
}

function scanRoots(root: string): string[] {
  const roots: string[] = [];
  for (const top of ['apps', 'packages']) {
    let names: string[] = [];
    try { names = readdirSync(join(root, top)); } catch { continue; }
    for (const n of names) for (const sub of top === 'apps' ? ['src', 'prisma'] : ['src']) {
      const d = join(root, top, n, sub);
      try { if (statSync(d).isDirectory()) roots.push(d); } catch { /* байхгүй */ }
    }
  }
  return roots;
}

/** `root` доорх `apps/<x>/{src,prisma}` ба `packages/<x>/src`-ээс шууд audit бичилтийг олно (`файл:мөр  төрөл`). */
export function findDirectAuditWrites(root: string): string[] {
  const hits: string[] = [];
  for (const file of scanRoots(root).flatMap((d) => walk(d, []))) {
    const rel = relative(root, file).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const f of FORBIDDEN) if (f.re.test(line)) hits.push(`${rel}:${i + 1}  ${f.name}`);
    });
  }
  return hits;
}

describe('audit_log writer guard', () => {
  it('no production code writes audit_log / audit_seal except through @los/database (insertAuditRow(s), recordAudit, sealer)', () => {
    expect(findDirectAuditWrites(REPO)).toEqual([]);
  });

  it('the scanner catches every forbidden form and ignores reads and test files (self-test on a temp tree)', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-guard-'));
    const dir = join(root, 'apps', 'svc', 'src');
    mkdirSync(dir, { recursive: true });
    const bad = [
      'await tx.auditLog.create({ data });',
      'await this.db.auditLog.createMany({ data: rows });',
      'await prisma.auditLog .upsert({});',
      "await tx['auditLog'].create({ data });",
      'await tx.$executeRawUnsafe(`INSERT INTO "origination"."audit_log" (id) VALUES ($1)`, id);',
      'await tx.$executeRaw`DELETE FROM iam.audit_log WHERE id = ${id}`;',
      'await tx.auditSeal.create({ data });',
      'await tx.$executeRawUnsafe(`UPDATE kyc.audit_seal SET mac = $1`, m);',
    ];
    writeFileSync(join(dir, 'bad.ts'), bad.join('\n'));
    writeFileSync(join(dir, 'ok.ts'), 'await insertAuditRow(tx, row);\nconst n = await prisma.auditLog.count();\nawait prisma.auditLog.findMany({});');
    writeFileSync(join(dir, 'bad.test.ts'), 'await tx.auditLog.create({ data });');
    expect(findDirectAuditWrites(root)).toEqual(bad.map((_, i) => expect.stringContaining(`apps/svc/src/bad.ts:${i + 1} `)));
  });
});
