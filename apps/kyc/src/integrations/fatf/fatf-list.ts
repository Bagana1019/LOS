// FATF-ийн жагсаалтын файл (FATF_LIST_FILE): унших + ХАТУУ шалгах. FATF нь machine-readable API өгдөггүй тул жагсаалтыг үйл ажиллагааны баг
// бүрэн хуралдаан (plenary, жилд ~3 удаа: 2, 6, 10-р сар) бүрийн дараа энэ файлд гараар шинэчилнэ. Формат нь docs: ./README.md.
// FAIL CLOSED: нэг талбар буруу бол БҮХ файлыг татгалзана (WatchlistService өмнөх snapshot-оо хадгална). Алдааны мессеж зөвхөн замыг/шалтгааны кодыг заана — утга, файлын зам биш.
import { statSync, readFileSync } from 'node:fs';
import { FatfCategory } from '@los/contracts';
import { z } from 'zod';
import { ExternalListError } from '../errors';
import type { FatfSnapshot } from './fatf.client';

export const FATF_LIST_MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 100; // FATF-ийн хоёр жагсаалт нийлээд ~30; хязгаар нь буруу файлаас хамгаална

function isRealDate(ymd: string): boolean {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(ymd);
}

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'not a real calendar date');
/** YYYY-MM-DD эсвэл бүтэн ISO-8601 цаг (Z / оффсет заавал). */
const publishedAt = z.string().refine((v) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return isRealDate(v);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
}, 'not an ISO-8601 date or date-time');

const entrySchema = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  countryName: z.string().trim().min(1).max(100),
  category: z.enum(FatfCategory),
  listedOn: ymd,
}).strict();

const fileSchema = z.object({
  version: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  publishedAt,
  entries: z.array(entrySchema).min(1).max(MAX_ENTRIES),
}).strict().superRefine((file, ctx) => {
  const seen = new Set<string>();
  file.entries.forEach((e, i) => {
    // Нэг улс хоёр жагсаалтад зэрэг байж болохгүй (FATF-д ийм зүйл байхгүй) — гараар засварлахад гарсан алдаа.
    if (seen.has(e.countryCode)) ctx.addIssue({ code: 'custom', path: ['entries', i, 'countryCode'], message: 'duplicate countryCode' });
    seen.add(e.countryCode);
  });
});

const unreadable = (): ExternalListError => new ExternalListError('fatf', 'FATF_LIST_FILE is unreadable');

/** ≤256 KiB файлыг нэг удаа уншина (хэдэн KB тул синхрон хангалттай). Зам алдаанд орохгүй. */
export function readFatfListFile(path: string): string {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw unreadable();
    size = st.size;
  } catch {
    throw unreadable();
  }
  if (size > FATF_LIST_MAX_BYTES) throw new ExternalListError('fatf', 'list file is too large');
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw unreadable();
  }
}

export function parseFatfList(input: string): FatfSnapshot {
  let json: unknown;
  try {
    json = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
  } catch {
    throw new ExternalListError('fatf', 'list file is not valid JSON');
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.code === 'custom' ? i.message : i.code}`);
    throw new ExternalListError('fatf', `list file is invalid (${issues.join('; ')})`);
  }
  const { version, entries } = parsed.data;
  const at = parsed.data.publishedAt;
  return { version, publishedAt: new Date(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T00:00:00.000Z` : at).toISOString(), entries };
}
