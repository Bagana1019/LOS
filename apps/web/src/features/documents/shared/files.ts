import { z } from 'zod';
import { API, authFetch } from '../../../lib/api';
import { newCorrelationId, readError } from '../../../lib/http';
import { t } from '../../../lib/i18n';

// dms файл сан (docs/05 §2): upload `POST /api/dms/files` (multipart, талбар `file`), татах `GET /api/dms/files/:id/content`. Gateway-ээр, bearer-тэй (`authFetch`).
// `dms/documents` нь дотоод тул ашиглахгүй — файлыг хүсэлт/барьцаанд холбох нь origination-оор.

/** dms-ийн FileView-ийн UI-д хэрэгтэй хэсэг (ALLOWED_TYPES-аас хамаарна: apps/dms/src/modules/file/file-type.ts). */
export const DmsFile = z.object({ id: z.string().uuid(), name: z.string(), mime: z.string(), size: z.number() });
export type DmsFile = z.infer<typeof DmsFile>;

/** `<input accept>`: dms-ийн зөвшөөрсөн өргөтгөлүүд (PDF, PNG, JPG, DOCX, XLSX, CSV, TXT). Эцсийн шалгалт сервер дээр (өргөтгөл + агуулга). */
export const DMS_ACCEPT = '.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv,.txt';

export async function uploadDmsFile(file: File): Promise<DmsFile> {
  const form = new FormData();
  form.append('file', file, file.name);
  const correlationId = newCorrelationId();
  // content-type-ийг хөтөч өөрөө (multipart boundary-тай) тавина
  const res = await authFetch(`${API}/dms/files`, { method: 'POST', body: form, headers: { accept: 'application/json', 'x-correlation-id': correlationId } });
  if (!res.ok) throw await readError(res, correlationId);
  return DmsFile.parse(await res.json());
}

export async function downloadDmsFile(fileId: string, fileName: string): Promise<void> {
  const correlationId = newCorrelationId();
  const res = await authFetch(`${API}/dms/files/${encodeURIComponent(fileId)}/content`, { headers: { 'x-correlation-id': correlationId } });
  if (!res.ok) throw await readError(res, correlationId);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName || 'file' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 1536 → "1.5 КБ". Харуулалт л. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return t('document.common.empty');
  if (bytes < 1024) return `${Math.round(bytes)} ${t('document.size.b')}`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} ${t('document.size.kb')}`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} ${t('document.size.mb')}`;
}
