// Audit seal (DECISIONS 2026-11-19): `audit_log` / `audit_seal` руу бичих ЦОРЫН ГАНЦ зам нь энэ багцын helper-ууд.
// Шинэ код шууд `auditLog.create(...)`, `INSERT INTO ... audit_log` бичвэл энэ тест УНАНА. Lint туслах (жинхэнэ хамгаалалт нь DB trigger):
// файлыг бүхэлд нь (олон мөрт) шалгана — alias (`const a = tx.auditLog`), destructuring, мөр хоорондын `tx.auditLog\n.create(`, schema-тай raw SQL.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../..');
/** Бичих эрхтэй файлууд (repo-оос харьцангуй). */
const ALLOWED = new Set(['packages/database/src/audit.ts', 'packages/database/src/audit-seal.ts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'test', 'e2e', 'testing', '__fixtures__', 'migrations']);
const isTestFile = (f: string) => /\.(test|spec|e2e)\.[cm]?[tj]sx?$/.test(f) || /(^|\/)test-[\w-]+\.ts$/.test(f);

const D = String.raw`audit(?:Log|Seal)`;
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'prisma delegate write', re: new RegExp(String.raw`\b${D}\s*\??\.\s*(?:create|createMany|createManyAndReturn|upsert|update|updateMany|delete|deleteMany)\s*\(`, 'g') },
  { name: 'bracket delegate access', re: new RegExp(String.raw`\[\s*['"\`]${D}['"\`]\s*\]`, 'g') },
  { name: 'delegate alias', re: new RegExp(String.raw`(?:[=:])\s*[\w$]+(?:\s*\??\.\s*[\w$]+)*\s*\??\.\s*${D}\b(?!\s*\??\.)`, 'g') },
  { name: 'delegate destructuring', re: new RegExp(String.raw`\{[^{}]*\b${D}\b[^{}]*\}\s*=(?![=>])`, 'g') },
  { name: 'raw SQL write', re: /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"?[\w${}]+"?\s*\.\s*)?"?audit_(?:log|seal)\b/gi },
];

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p, out); continue; }
    if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts') && !isTestFile(name)) out.push(p);
  }
  return out;
}

const isDir = (d: string) => { try { return statSync(d).isDirectory(); } catch { return false; } };
function scanRoots(root: string): string[] {
  const roots = [join(root, 'scripts')];
  for (const [top, subs] of [['apps', ['src', 'prisma', 'scripts']], ['packages', ['src', 'scripts']]] as const) {
    let names: string[] = [];
    try { names = readdirSync(join(root, top)); } catch { continue; }
    for (const n of names) for (const sub of subs) roots.push(join(root, top, n, sub));
  }
  return roots.filter(isDir);
}

/** `root` доорх `scripts/`, `apps/<x>/{src,prisma,scripts}`, `packages/<x>/{src,scripts}`-ээс шууд audit бичилтийг олно (`файл:мөр  төрөл`). */
export function findDirectAuditWrites(root: string): string[] {
  const hits: string[] = [];
  for (const file of scanRoots(root).flatMap((d) => walk(d, []))) {
    const rel = relative(root, file).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const f of FORBIDDEN) {
      for (const m of text.matchAll(f.re)) hits.push(`${rel}:${text.slice(0, m.index).split('\n').length}  ${f.name}`);
    }
  }
  return hits.sort();
}

describe('audit_log writer guard', () => {
  it('no production code writes audit_log / audit_seal except through @los/database (insertAuditRow(s), recordAudit, sealer)', () => {
    expect(findDirectAuditWrites(REPO)).toEqual([]);
  });

  it('the scanner catches every forbidden form (incl. multi-line, aliasing, scripts/) and ignores reads and test files', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-guard-'));
    const dir = join(root, 'apps', 'svc', 'src');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    const bad = [
      'await tx.auditLog.create({ data });',
      'await this.db.auditLog.createMany({ data: rows });',
      'await prisma.auditLog .upsert({});',
      "await tx['auditLog'].create({ data });",
      'await tx.$executeRawUnsafe(`INSERT INTO "origination"."audit_log" (id) VALUES ($1)`, id);',
      'await tx.$executeRaw`DELETE FROM iam.audit_log WHERE id = ${id}`;',
      'await tx.auditSeal.create({ data });',
      'await tx.$executeRawUnsafe(`UPDATE kyc.audit_seal SET mac = $1`, m);',
      'await tx.auditLog?.create({ data });',
    ];
    const multi = [
      'await tx.auditLog\n  .create({ data });',
      'await tx.$executeRawUnsafe(`INSERT INTO\n  "${S}"."audit_log" (id) VALUES ($1)`, id);',
      'const a = tx.auditLog;\nawait a.create({ data });',
      'const { auditLog } = tx;\nawait auditLog.create({ data });',
      'const w = { log: tx.auditLog };',
    ];
    writeFileSync(join(dir, 'bad.ts'), bad.join('\n'));
    writeFileSync(join(dir, 'multi.ts'), multi.join('\n'));
    writeFileSync(join(root, 'scripts', 'fix.mjs'), 'await db.$executeRawUnsafe("TRUNCATE iam.audit_log");');
    writeFileSync(join(dir, 'ok.ts'), [
      'await insertAuditRow(tx, row);', 'const n = await prisma.auditLog.count();', 'await prisma.auditLog\n  .findMany({});',
      '// UPDATE / DELETE / TRUNCATE on audit_log are rejected by the trigger', 'type T = { auditLog: { create(a: unknown): unknown } };',
    ].join('\n'));
    writeFileSync(join(dir, 'bad.test.ts'), 'await tx.auditLog.create({ data });');
    const hits = findDirectAuditWrites(root);
    for (let i = 1; i <= bad.length; i += 1) expect(hits).toContainEqual(expect.stringMatching(new RegExp(`^apps/svc/src/bad\\.ts:${i} `)));
    for (const line of [1, 3, 5, 7, 9]) expect(hits).toContainEqual(expect.stringMatching(new RegExp(`^apps/svc/src/multi\\.ts:${line} `)));
    expect(hits).toContainEqual(expect.stringMatching(/^scripts\/fix\.mjs:1 /));
    expect(hits.filter((h) => h.includes('ok.ts') || h.includes('bad.test.ts'))).toEqual([]);
  });
});
