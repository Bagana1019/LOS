import type { RequestContext } from '@los/contracts';
import { DomainError } from '../http/errors';

/** Дотоод сервисийн хэрэглэгчийн угтвар (`svc:origination-files` гэх мэт) — dms `canReadFileContent`-тэй ижил. */
export const SERVICE_USER_PREFIX = 'svc:';

/**
 * NFR-3 · файл хавсаргах эзэмшил: хэрэглэгч файлыг хүсэлтэд (барьцааны баримт, үнэлгээний тайлан, гарын үсэгтэй гэрээ, dms баримт) хавсаргахдаа
 * ТЭР файлыг өөрөө байршуулсан байх ёстой. Эс бөгөөс өөр хүний файлын id-г өөрийн хүсэлтэд хавсаргаад, "хүсэлтэд холбогдсон" гэсэн нөхцлөөр татаж болно.
 * Сервисийн хэрэглэгч (`svc:`) чөлөөлөгдөнө. `uploadedBy` тодорхойгүй (хуучин мөр) бол эзэмшил батлагдаагүй тул татгалзана.
 */
export function isFileUploadedByCaller(ctx: Pick<RequestContext, 'userId'>, uploadedBy: string | null | undefined): boolean {
  if (!ctx.userId) return false;
  if (ctx.userId.startsWith(SERVICE_USER_PREFIX)) return true;
  return uploadedBy === ctx.userId;
}

export function assertFileUploadedByCaller(ctx: Pick<RequestContext, 'userId'>, uploadedBy: string | null | undefined): void {
  if (!isFileUploadedByCaller(ctx, uploadedBy)) {
    throw new DomainError('FILE_NOT_OWNED', 'Зөвхөн өөрөө байршуулсан файлыг хавсаргана. Файлыг дахин байршуулна уу', 403);
  }
}
