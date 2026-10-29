// FR-11.4 Hash туслахууд. Нууц биш ч гэсэн hash/digest-ийг тулгахдаа тогтмол хугацааны харьцуулалт хэрэглэнэ.
import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hex digest-үүдийг тогтмол хугацаанд тулгана (том/жижиг үсэг ялгахгүй). Хоосон эсвэл урт зөрвөл `false` (digest-ийн урт нь нийтийн мэдээлэл) */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), 'utf8'), Buffer.from(b.toLowerCase(), 'utf8'));
}
