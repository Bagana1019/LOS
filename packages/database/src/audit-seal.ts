// Audit seal — `audit_log`-ийн tamper evidence (NFR-4, M10 follow-up; docs/DECISIONS.md 2026-11-19 · audit seal).
//
// Бичигчийг serialize ХИЙХГҮЙ: мөр бүрийг BEFORE INSERT trigger бичигч транзакцын `pg_current_xact_id()`-аар (`tx_id`, xid8) тэмдэглэнэ.
// Sealer нь `horizon = pg_snapshot_xmin(pg_current_snapshot())`-ийг авна: horizon-оос доош xid-тэй транзакц БҮГД дууссан тул
// `tx_id < horizon` мөрийн олонлог цаашид хэзээ ч өсөхгүй (удаан commit хийсэн мөр seal-ийн араас "орж ирэхгүй" — `at`-аар watermark
// хийвэл энэ нь алдагдана: `at` = транзакц эхэлсэн цаг / gateway fallback-д клиентийн цаг). Мөрүүдийг (tx_id, id COLLATE "C") дарааллаар,
// өмнөх seal-ийн курсороос хойш batch-аар `audit_seal`-д гинжилнэ: mac_n = HMAC-SHA256(key, header(seq, keyId, prev_mac, count, cursor) || rows).
// Нэг pod: `pg_try_advisory_xact_lock` + `seq` PK (давхар seal үүсэх боломжгүй). Түлхүүр, мөрийн агуулгыг хэзээ ч логлохгүй.
// Sealer өөрийн харсан толгойг (seq, mac) санана: DB-ийн гинж түүнээс ухарсан/өөрчлөгдсөн бол (owner trigger-ийг унтрааж сүүлийн seal-үүдийг
// устгаад мөр засвал) ДАХИН seal хийхгүй — зогсоно (CHAIN_REGRESSED). Мөн horizon ухрах (өөр кластерт restore) ба хуучин түлхүүр рүү буцахыг хориглоно.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { advisoryLockKey } from './advisory-lock';

export type AuditColumnKind = 'text' | 'xid' | 'ts' | 'json';
export interface AuditColumn { name: string; kind: AuditColumnKind }
export interface AuditSealConfig { schema: string; columns: readonly AuditColumn[] }

const col = (name: string, kind: AuditColumnKind = 'text'): AuditColumn => ({ name, kind });
/** origination / kyc `audit_log` — seal-д орох БҮХ багана (drift тест: DB-ийн багана = энэ жагсаалт). */
export const AUDIT_SEAL_COLUMNS: readonly AuditColumn[] = [
  col('id'), col('tx_id', 'xid'), col('org_id'), col('entity'), col('entity_id'), col('action'), col('actor_id'), col('at', 'ts'),
  col('before_json', 'json'), col('after_json', 'json'), col('application_id'), col('correlation_id'),
];
/** gateway `iam.audit_log` — нэмэлт `ip`, `user_agent`. */
export const GATEWAY_AUDIT_SEAL_COLUMNS: readonly AuditColumn[] = [...AUDIT_SEAL_COLUMNS, col('ip'), col('user_agent')];

export const AUDIT_SEAL_ALGO = 'los-audit-seal/v1';
export const MIN_AUDIT_HMAC_KEY_LENGTH = 32;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const PREVIOUS_KEY_ENTRY_RE = /^[A-Za-z0-9_.-]+:[^,\s]+$/;

export interface AuditKeyring { currentKeyId: string; keys: ReadonlyMap<string, Buffer> }

/**
 * `AUDIT_HMAC_KEY` (одоогийн), `AUDIT_HMAC_KEY_ID` (анхдагч `k1`, seal бүрт хадгалагдана), `AUDIT_HMAC_PREVIOUS_KEYS` (`id:key,id:key` — rotation-ий
 * дараа хуучин seal-ийг шалгахад л). Түлхүүр байхгүй/хоосон бол null. Формат буруу бол throw (мессежид түлхүүр орохгүй).
 * Хүч чадлын (урт, placeholder) шалгалт нь production bootstrap-д: @los/nest-common `assertAuditHmacKey`.
 */
export function auditKeyringFromEnv(env: Record<string, string | undefined> = process.env): AuditKeyring | null {
  const key = env.AUDIT_HMAC_KEY?.trim() ?? '';
  if (!key) return null;
  const currentKeyId = env.AUDIT_HMAC_KEY_ID?.trim() || 'k1';
  if (!KEY_ID_RE.test(currentKeyId)) throw new Error('AUDIT_HMAC_KEY_ID must match [A-Za-z0-9._-]{1,32}');
  const keys = new Map<string, Buffer>([[currentKeyId, Buffer.from(key, 'utf8')]]);
  const raw = env.AUDIT_HMAC_PREVIOUS_KEYS?.trim() ?? '';
  // Хатуу: entry бүр `<id>:<key>`, key-д таслал/зай байхгүй (эс бөгөөс таслалтай key чимээгүй буруу key болно). Алдааны мессежид утга орохгүй.
  for (const [n, part] of (raw ? raw.split(',') : []).map((s, k) => [k + 1, s.trim()] as const)) {
    if (!PREVIOUS_KEY_ENTRY_RE.test(part)) throw new Error(`AUDIT_HMAC_PREVIOUS_KEYS entry #${n} must be <keyId>:<key> (key without commas or whitespace)`);
    const i = part.indexOf(':');
    const id = part.slice(0, i);
    const value = part.slice(i + 1);
    if (!KEY_ID_RE.test(id)) throw new Error(`AUDIT_HMAC_PREVIOUS_KEYS entry #${n}: key id must match [A-Za-z0-9._-]{1,32}`);
    if (keys.has(id)) throw new Error(`AUDIT_HMAC_PREVIOUS_KEYS repeats key id "${id}" (or reuses AUDIT_HMAC_KEY_ID)`);
    keys.set(id, Buffer.from(value, 'utf8'));
  }
  return { currentKeyId, keys };
}

/**
 * Мөрийн canonical хэлбэр: тохируулсан багануудыг тогтмол дарааллаар, Postgres-ийн text гаралтаар ЯГ байгаагаар (parse/дахин serialize хийхгүй —
 * jsonb-ийн `::text` нь детерминист: түлхүүр нормчлогдсон, тоо хадгалсан хэлбэрээрээ — 1.10, 2^53-аас их тоо алдагдахгүй). SQL NULL → JSON null,
 * jsonb `null` → `"null"` мөр (ялгаатай).
 */
export function canonicalAuditRow(columns: readonly AuditColumn[], row: Record<string, string | null>): string {
  return JSON.stringify(columns.map((c) => row[c.name] ?? null));
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`invalid SQL identifier: ${s}`);
  return `"${s}"`;
};
const table = (schema: string, name: 'audit_log' | 'audit_seal') => `${ident(schema)}."${name}"`;
function selectList(columns: readonly AuditColumn[]): string {
  return columns.map((c) => {
    const n = ident(c.name);
    return `${c.kind === 'ts' ? `to_char(${n}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : `${n}::text`} AS ${n}`;
  }).join(', ');
}

export interface SealTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
type QueryDb = Pick<SealTx, '$queryRawUnsafe'>;
/** Сервисийн PrismaService бүтцээрээ тохирно. */
export interface AuditSealDb extends QueryDb {
  $transaction<R>(fn: (tx: SealTx) => Promise<R>, options?: { maxWait?: number; timeout?: number; isolationLevel?: 'ReadCommitted' }): Promise<R>;
}

interface SealRow { seq: string; key_id: string; last_tx_id: string; last_id: string; row_count: number; prev_mac: string | null; mac: string }
interface Cursor { txId: string; id: string }
type Upper = { horizon: string } | { through: Cursor };
export interface SealHead { seq: string; mac: string }

// ORDER BY-д ЗААВАЛ хүснэгтийн alias (a./s.): энгийн нэр нь SELECT-ийн text alias-ийг (`tx_id::text AS "tx_id"`) заана → text эрэмбэ ('10' < '9').
const SEAL_COLS = 's.seq::text AS seq, s.key_id, s.last_tx_id::text AS last_tx_id, s.last_id, s.row_count, s.prev_mac, s.mac';
const AFTER = (i: number) => `(a."tx_id", a."id" COLLATE "C") > ($${i}::xid8, $${i + 1}::text COLLATE "C")`;

/** `from` (хамааруулахгүй) → `upper` хүртэлх мөрүүд (tx_id, id COLLATE "C") дарааллаар, бүх багана text. */
async function readRows(db: QueryDb, cfg: AuditSealConfig, from: Cursor | null, upper: Upper, limit?: number) {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const conds: string[] = [];
  if (from) { conds.push(AFTER(params.length + 1)); params.push(from.txId, from.id); }
  if ('horizon' in upper) conds.push(`a."tx_id" < ${p(upper.horizon)}::xid8`);
  else conds.push(`(a."tx_id", a."id" COLLATE "C") <= (${p(upper.through.txId)}::xid8, ${p(upper.through.id)}::text COLLATE "C")`);
  const sql = `SELECT ${selectList(cfg.columns)} FROM ${table(cfg.schema, 'audit_log')} a WHERE ${conds.join(' AND ')} ORDER BY a."tx_id", a."id" COLLATE "C"${limit ? ` LIMIT ${Math.trunc(limit)}` : ''}`;
  return db.$queryRawUnsafe<Record<string, string | null>[]>(sql, ...params);
}

function sealMac(key: Buffer, schema: string, s: { seq: string; keyId: string; prevMac: string | null; count: number; last: Cursor }, rows: string[]): string {
  const h = createHmac('sha256', key);
  h.update(`${JSON.stringify([AUDIT_SEAL_ALGO, schema, s.seq, s.keyId, s.prevMac, s.count, s.last.txId, s.last.id])}\n`);
  for (const r of rows) h.update(`${r}\n`);
  return h.digest('hex');
}
const macEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const horizonOf = async (db: QueryDb) => (await db.$queryRawUnsafe<{ horizon: string }[]>('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon'))[0]!.horizon;

/** Seal хийхээс татгалзсан шалтгаан (бүгд хүний оролцоо шаардана; sealer зогсоно). */
export type SealRegression = 'CHAIN_REGRESSED' | 'HORIZON_REGRESSED' | 'KEY_DOWNGRADE';
export interface SealOptions {
  batchSize?: number; maxBatches?: number; holdMs?: number;
  /** Энэ sealer-ийн өмнө харсан толгой: DB-д тэр seq тэр mac-тайгаа байх ёстой (эс бөгөөс CHAIN_REGRESSED). */
  expectedHead?: SealHead | null;
  /**
   * Batch бүрийн транзакц commit болмогц (дараагийн batch эхлэхээс ӨМНӨ) синхрон дуудагдана. Дараагийн batch throw хийсэн ч commit болсон seal
   * логлогдож (WORM anchor), толгой урагшилна — эс бөгөөс owner логлогдоогүй seal-ийг устгаад мөрийг засаж дахин seal хийлгэж чадна.
   */
  onSealed?: (seal: { seq: string; rows: number; mac: string }, head: SealHead) => void;
}
export interface SealResult { locked: boolean; regressed: SealRegression | null; head: SealHead | null; seals: { seq: string; rows: number; mac: string }[] }
type Once = { kind: 'locked' } | { kind: 'regressed'; reason: SealRegression } | { kind: 'ok'; head: SealHead | null; sealed: { seq: string; rows: number; mac: string } | null };

/** Толгойн шалгалт: хүлээгдэж буй seal байхгүй/өөр mac-тай, horizon ухарсан, эсвэл хуучин түлхүүр рүү буцсан бол шалтгаан. */
async function checkHead(tx: SealTx, cfg: AuditSealConfig, prev: SealRow | null, expected: SealHead | null, horizon: string, keyId: string): Promise<SealRegression | null> {
  if (expected) {
    if (!prev || BigInt(prev.seq) < BigInt(expected.seq)) return 'CHAIN_REGRESSED';
    const mac = prev.seq === expected.seq ? prev.mac
      : (await tx.$queryRawUnsafe<{ mac: string }[]>(`SELECT s.mac FROM ${table(cfg.schema, 'audit_seal')} s WHERE s.seq = $1::bigint`, expected.seq))[0]?.mac;
    if (mac === undefined || !macEq(mac, expected.mac)) return 'CHAIN_REGRESSED';
  }
  // Ердийн үед last_tx_id < тухайн үеийн horizon ≤ одоогийн horizon. Эсрэгээрээ бол xid тоолуур өөр (restore/логик репликац) — шинэ мөр курсороос доош орно.
  if (prev && BigInt(horizon) <= BigInt(prev.last_tx_id)) return 'HORIZON_REGRESSED';
  if (prev && prev.key_id !== keyId) {
    const used = await tx.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${table(cfg.schema, 'audit_seal')} s WHERE s.key_id = $1 LIMIT 1`, keyId);
    if (used.length > 0) return 'KEY_DOWNGRADE'; // энэ түлхүүрийг аль хэдийн сольсон — буцаж ашиглахгүй
  }
  return null;
}

/** Нэг batch нэг транзакцид: түгжээ → horizon → толгойн шалгалт → мөрүүд → INSERT. */
async function sealOnce(db: AuditSealDb, cfg: AuditSealConfig, keyring: AuditKeyring, batchSize: number, holdMs: number, expected: SealHead | null): Promise<Once> {
  return db.$transaction(async (tx): Promise<Once> => {
    const lock = await tx.$queryRawUnsafe<{ locked: boolean }[]>('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', advisoryLockKey(`audit-seal:${cfg.schema}`).toString());
    if (!lock[0]?.locked) return { kind: 'locked' };
    // horizon-ий баталгаа READ COMMITTED-д л үнэн: дараагийн SELECT шинэ snapshot авч horizon-оос доош бүх commit-ийг харна.
    // REPEATABLE READ+ үед snapshot түгжээний өмнө авагдаж, horizon-оос доош мөр алгасагдана — тиймээс хатуу шалгана.
    const [{ iso }] = await tx.$queryRawUnsafe<{ iso: string }[]>("SELECT current_setting('transaction_isolation') AS iso");
    if (iso !== 'read committed') throw new Error(`audit seal requires READ COMMITTED (got ${iso})`);
    const horizon = await horizonOf(tx);
    const prev = (await tx.$queryRawUnsafe<SealRow[]>(`SELECT ${SEAL_COLS} FROM ${table(cfg.schema, 'audit_seal')} s ORDER BY s.seq DESC LIMIT 1`))[0] ?? null;
    const keyId = keyring.currentKeyId;
    const regressed = await checkHead(tx, cfg, prev, expected, horizon, keyId);
    if (regressed) return { kind: 'regressed', reason: regressed };
    const head = prev && { seq: prev.seq, mac: prev.mac };
    const rows = await readRows(tx, cfg, prev && { txId: prev.last_tx_id, id: prev.last_id }, { horizon }, batchSize);
    if (rows.length === 0) return { kind: 'ok', head, sealed: null };
    const tail = rows[rows.length - 1]!;
    const last = { txId: tail.tx_id!, id: tail.id! };
    const seq = prev ? (BigInt(prev.seq) + 1n).toString() : '1';
    const mac = sealMac(keyring.keys.get(keyId)!, cfg.schema, { seq, keyId, prevMac: prev?.mac ?? null, count: rows.length, last }, rows.map((r) => canonicalAuditRow(cfg.columns, r)));
    await tx.$executeRawUnsafe(
      `INSERT INTO ${table(cfg.schema, 'audit_seal')} (seq, key_id, last_tx_id, last_id, row_count, prev_mac, mac) VALUES ($1::bigint, $2, $3::xid8, $4, $5::int, $6, $7)`,
      seq, keyId, last.txId, last.id, rows.length, prev?.mac ?? null, mac,
    );
    return { kind: 'ok', head: { seq, mac }, sealed: { seq, rows: rows.length, mac } };
  }, { maxWait: 10_000, timeout: holdMs, isolationLevel: 'ReadCommitted' });
}

/**
 * Commit болсон, seal хийгдээгүй мөрүүдийг batch-аар гинжилнэ. Idempotent: шинэ мөргүй бол юу ч бичихгүй. `head` = хамгийн сүүлд харсан
 * толгой — дуудагч (AuditSealerHost) дараагийн дуудлагад `expectedHead` болгон дамжуулна. `regressed` бол юу ч бичээгүй, дуудагч зогсох ёстой.
 */
export async function sealAuditLog(db: AuditSealDb, cfg: AuditSealConfig, keyring: AuditKeyring, opts: SealOptions = {}): Promise<SealResult> {
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 500, 5_000));
  const seals: SealResult['seals'] = [];
  let head = opts.expectedHead ?? null;
  for (let i = 0; i < (opts.maxBatches ?? 20); i += 1) {
    const r = await sealOnce(db, cfg, keyring, batchSize, opts.holdMs ?? 30_000, head);
    if (r.kind === 'locked') return { locked: true, regressed: null, head, seals };
    if (r.kind === 'regressed') return { locked: false, regressed: r.reason, head, seals };
    head = r.head;
    if (!r.sealed) break;
    seals.push(r.sealed);
    opts.onSealed?.(r.sealed, { seq: r.sealed.seq, mac: r.sealed.mac });
    if (r.sealed.rows < batchSize) break;
  }
  return { locked: false, regressed: null, head, seals };
}

export type AuditChainBreak =
  | 'SEQ_GAP' | 'PREV_MAC_MISMATCH' | 'UNKNOWN_KEY' | 'KEY_DOWNGRADE' | 'CURSOR_NOT_ADVANCING' | 'ROW_COUNT_MISMATCH' | 'MAC_MISMATCH'
  | 'ANCHOR_MISMATCH' | 'HORIZON_REGRESSED';
export interface AuditChainReport {
  ok: boolean; seals: number; sealedRows: number;
  /** Сүүлийн seal-ээс хойших мөр (хараахан seal хийгдээгүй); эвдэрсэн үед null. */
  unsealedRows: number | null;
  /** Тэдгээрээс horizon-оос доош (seal хийгдэх ёстой байсан) мөр; эвдэрсэн үед null. */
  backlogBelowHorizon: number | null;
  /** Гадаад anchor өгөгдөж, таарсан эсэх. Anchor-гүй OK нь "сүүлийн seal-үүдийг устгаад дахин seal хийсэн" байдлыг үгүйсгэхгүй. */
  anchored: boolean;
  last: SealHead | null;
  firstBroken: { seq: string; reason: AuditChainBreak; expectedRows?: number; actualRows?: number } | null;
}

const cmpCursor = (a: Cursor, b: Cursor) => {
  const d = BigInt(a.txId) - BigInt(b.txId);
  if (d !== 0n) return d < 0n ? -1 : 1;
  return Buffer.compare(Buffer.from(a.id, 'utf8'), Buffer.from(b.id, 'utf8')); // COLLATE "C" = байтын дараалал
};

/**
 * Бүх seal-ийг seq-ээр дахин тооцоолж ЭХНИЙ эвдэрсэн холбоосыг буцаана: өөрчилсөн талбар / устгасан эсвэл нэмсэн мөр / дарааллыг
 * сольсон (tx_id/id) мөр → MAC_MISMATCH эсвэл ROW_COUNT_MISMATCH; устгасан/сольсон seal → SEQ_GAP / PREV_MAC_MISMATCH; буруу түлхүүр →
 * MAC_MISMATCH (id мэдэгдэхгүй бол UNKNOWN_KEY, сольсон түлхүүр рүү буцсан бол KEY_DOWNGRADE); xid тоолуур ухарсан → HORIZON_REGRESSED.
 * Owner эрхтэй этгээд сүүлийн seal-үүдийг устгаад мөр засаж ЖИНХЭНЭ түлхүүрээр дахин seal хийлгэвэл DB дотроос харагдахгүй — зөвхөн
 * `anchor` (WORM-д хадгалсан `AUDIT_SEALED seq mac` лог) үүнийг илрүүлнэ. Тиймээс production CLI anchor-гүй OK хэвлэхгүй.
 */
export async function verifyAuditChain(db: QueryDb, cfg: AuditSealConfig, keyring: AuditKeyring, opts: { anchor?: SealHead; pageSize?: number } = {}): Promise<AuditChainReport> {
  const pageSize = opts.pageSize ?? 1_000;
  const anchor = opts.anchor;
  let prev: { seq: string; mac: string; keyId: string; cursor: Cursor } | null = null;
  const retiredKeys = new Set<string>();
  let seals = 0;
  let sealedRows = 0;
  let anchorSeen = false;
  const broken = (seq: string, reason: AuditChainBreak, extra: { expectedRows?: number; actualRows?: number } = {}): AuditChainReport =>
    ({ ok: false, seals, sealedRows, unsealedRows: null, backlogBelowHorizon: null, anchored: false, last: prev && { seq: prev.seq, mac: prev.mac }, firstBroken: { seq, reason, ...extra } });
  // Эхлээд: xid тоолуур ухарсан (өөр кластерт restore) бол шинэ мөрүүд seal хийгдсэн мужид орж ирдэг — үндсэн шалтгааныг нэрлэнэ.
  const horizon = await horizonOf(db);
  const head = (await db.$queryRawUnsafe<SealRow[]>(`SELECT ${SEAL_COLS} FROM ${table(cfg.schema, 'audit_seal')} s ORDER BY s.seq DESC LIMIT 1`))[0];
  if (head && BigInt(horizon) <= BigInt(head.last_tx_id)) return broken(head.seq, 'HORIZON_REGRESSED');
  for (;;) {
    const page: SealRow[] = await db.$queryRawUnsafe<SealRow[]>(`SELECT ${SEAL_COLS} FROM ${table(cfg.schema, 'audit_seal')} s WHERE s.seq > $1::bigint ORDER BY s.seq LIMIT ${pageSize}`, prev?.seq ?? '0');
    for (const s of page) {
      const expectedSeq: string = prev ? (BigInt(prev.seq) + 1n).toString() : '1';
      if (s.seq !== expectedSeq) return broken(expectedSeq, 'SEQ_GAP');
      if ((s.prev_mac ?? null) !== (prev?.mac ?? null)) return broken(s.seq, 'PREV_MAC_MISMATCH');
      const key = keyring.keys.get(s.key_id);
      if (!key) return broken(s.seq, 'UNKNOWN_KEY');
      if (retiredKeys.has(s.key_id)) return broken(s.seq, 'KEY_DOWNGRADE');
      const last: Cursor = { txId: s.last_tx_id, id: s.last_id };
      if (prev && cmpCursor(last, prev.cursor) <= 0) return broken(s.seq, 'CURSOR_NOT_ADVANCING');
      const rows = await readRows(db, cfg, prev?.cursor ?? null, { through: last });
      if (rows.length !== s.row_count) return broken(s.seq, 'ROW_COUNT_MISMATCH', { expectedRows: s.row_count, actualRows: rows.length });
      const mac: string = sealMac(key, cfg.schema, { seq: s.seq, keyId: s.key_id, prevMac: s.prev_mac ?? null, count: s.row_count, last }, rows.map((r) => canonicalAuditRow(cfg.columns, r)));
      if (!macEq(mac, s.mac)) return broken(s.seq, 'MAC_MISMATCH');
      if (anchor && anchor.seq === s.seq) {
        if (!macEq(anchor.mac, s.mac)) return broken(s.seq, 'ANCHOR_MISMATCH');
        anchorSeen = true;
      }
      if (prev && prev.keyId !== s.key_id) retiredKeys.add(prev.keyId);
      prev = { seq: s.seq, mac: s.mac, keyId: s.key_id, cursor: last };
      seals += 1;
      sealedRows += rows.length;
    }
    if (page.length < pageSize) break;
  }
  if (anchor && !anchorSeen) return broken(anchor.seq, 'ANCHOR_MISMATCH');
  const sql = `SELECT count(*)::int AS n, (count(*) FILTER (WHERE a."tx_id" < $1::xid8))::int AS b FROM ${table(cfg.schema, 'audit_log')} a`;
  const tail = prev
    ? await db.$queryRawUnsafe<{ n: number; b: number }[]>(`${sql} WHERE ${AFTER(2)}`, horizon, prev.cursor.txId, prev.cursor.id)
    : await db.$queryRawUnsafe<{ n: number; b: number }[]>(sql, horizon);
  return {
    ok: true, seals, sealedRows, unsealedRows: tail[0]?.n ?? 0, backlogBelowHorizon: tail[0]?.b ?? 0, anchored: anchorSeen,
    last: prev && { seq: prev.seq, mac: prev.mac }, firstBroken: null,
  };
}
