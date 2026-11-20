// Audit seal CLI-ийн нийтлэг хэсэг (сервис бүрийн `src/audit-seal.cli.ts` дуудна). Хэвлэх: seq, тоо, mac, шалтгаан л — түлхүүр, мөрийн агуулга хэзээ ч биш.
//   verify [--anchor <seq>:<mac>] [--strict]   — гинжийг бүхэлд нь дахин тооцоолно.
//       exit 0 OK · 1 BROKEN / NOT_OK (NO_SEALS) · 2 usage · 3 UNANCHORED
//       Strict (NODE_ENV=production эсвэл --strict): anchor-гүй бол OK БИШ (UNANCHORED, exit 3) — owner сүүлийн seal-үүдийг устгаад мөр засаж,
//       sealer дахин seal хийсэн байдлыг зөвхөн WORM-д хадгалсан `AUDIT_SEALED` anchor илрүүлнэ; seal огт байхгүй атал horizon-оос доош мөр байвал NOT_OK.
//   seal                                        — нэг удаагийн seal (sealer-ийн tick-тэй адил, түгжээтэй)
import { auditKeyringFromEnv, sealAuditLog, verifyAuditChain, type AuditChainReport, type AuditSealConfig, type AuditSealDb } from './audit-seal';

export type VerifyStatus = 'OK' | 'BROKEN' | 'NO_SEALS' | 'UNANCHORED';
const EXIT: Record<VerifyStatus, number> = { OK: 0, BROKEN: 1, NO_SEALS: 1, UNANCHORED: 3 };

/** Тайлангаас статус: strict үед anchor заавал, seal-гүй backlog = NOT_OK. */
export function verifyStatus(r: AuditChainReport, strict: boolean): VerifyStatus {
  if (!r.ok) return 'BROKEN';
  if (strict && r.seals === 0 && (r.backlogBelowHorizon ?? 0) > 0) return 'NO_SEALS';
  if (strict && !r.anchored) return 'UNANCHORED';
  return 'OK';
}

function describe(cfg: AuditSealConfig, r: AuditChainReport, status: VerifyStatus): string {
  const head = `schema=${cfg.schema} seals=${r.seals} sealedRows=${r.sealedRows}`;
  const last = `lastSeq=${r.last?.seq ?? '-'} lastMac=${r.last?.mac ?? '-'}`;
  if (status === 'BROKEN') {
    const b = r.firstBroken!;
    const rows = b.expectedRows === undefined ? '' : ` expectedRows=${b.expectedRows} actualRows=${b.actualRows}`;
    return `BROKEN schema=${cfg.schema} seq=${b.seq} reason=${b.reason}${rows} verifiedSeals=${r.seals} lastGoodSeq=${r.last?.seq ?? '-'}`;
  }
  if (status === 'NO_SEALS') return `NOT_OK reason=NO_SEALS ${head} backlogBelowHorizon=${r.backlogBelowHorizon}`;
  if (status === 'UNANCHORED') return `UNANCHORED ${head} ${last}: chain is self-consistent but unproven without --anchor <seq>:<mac> from WORM-stored AUDIT_SEALED logs`;
  return `OK ${head} unsealedRows=${r.unsealedRows} backlogBelowHorizon=${r.backlogBelowHorizon} anchored=${r.anchored ? 'yes' : 'no'} ${last}`;
}

export async function runAuditSealCli(db: AuditSealDb, cfg: AuditSealConfig, argv: string[], out: (line: string) => void, env: Record<string, string | undefined> = process.env): Promise<number> {
  const [cmd, ...rest] = argv;
  const keyring = auditKeyringFromEnv(env);
  if (!keyring) { out('AUDIT_HMAC_KEY is required'); return 2; }
  if (cmd === 'seal') {
    // Seal бүрийг commit болмогц хэвлэнэ (дараагийн batch унасан ч commit болсон seal хэвлэгдсэн байна — WORM anchor).
    const r = await sealAuditLog(db, cfg, keyring, { onSealed: (s) => out(`SEALED schema=${cfg.schema} seq=${s.seq} rows=${s.rows} mac=${s.mac}`) });
    if (r.locked) out(`LOCKED schema=${cfg.schema}: another sealer holds the lock`);
    if (r.regressed) { out(`AUDIT_SEAL_${r.regressed} schema=${cfg.schema}: refusing to seal`); return 1; }
    return 0;
  }
  if (cmd === 'verify') {
    const i = rest.indexOf('--anchor');
    const raw = i >= 0 ? rest[i + 1] ?? '' : '';
    const m = /^(\d+):([0-9a-f]{64})$/.exec(raw);
    if (i >= 0 && !m) { out('--anchor must be <seq>:<64 hex mac>'); return 2; }
    const strict = rest.includes('--strict') || env.NODE_ENV?.trim().toLowerCase() === 'production';
    const r = await verifyAuditChain(db, cfg, keyring, m ? { anchor: { seq: m[1]!, mac: m[2]! } } : {});
    const status = verifyStatus(r, strict);
    out(describe(cfg, r, status));
    return EXIT[status];
  }
  out('usage: audit-seal verify [--anchor <seq>:<mac>] [--strict] | seal');
  return 2;
}
