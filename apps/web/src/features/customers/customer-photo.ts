/**
 * F1-12: ИҮ-ийн зургийн клиент талын шалгалт — илгээхээс өмнө ойлгомжтой мессеж өгөхөд. Эцсийн шалгалтыг dms сервер хийнэ.
 * Төрөл нь `CustomerForm`-ын өмнөх `accept`-тэй ижил; хэмжээ нь dms `FILE_MAX_BYTES`-ийн анхдагч (apps/dms/src/modules/file/file.service.ts: 20 MB).
 */
export const PHOTO_ACCEPT = '.png,.jpg,.jpeg,.pdf';
const PHOTO_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'pdf']);
export const PHOTO_MAX_BYTES = 20 * 1024 * 1024;
export const PHOTO_MAX_MB = PHOTO_MAX_BYTES / (1024 * 1024);

export type PhotoRejectReason = 'EMPTY' | 'TYPE' | 'TOO_LARGE';

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

/** Зөв бол null, үгүй бол татгалзсан шалтгаан. Хоосон (0 байт) файлыг төрлөөс түрүүлж шалгана. */
export function validatePhotoFile(file: { name: string; size: number }): PhotoRejectReason | null {
  if (file.size === 0) return 'EMPTY';
  if (!PHOTO_EXTENSIONS.has(extensionOf(file.name))) return 'TYPE';
  if (file.size > PHOTO_MAX_BYTES) return 'TOO_LARGE';
  return null;
}
