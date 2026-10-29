// FR-11.4 Штамп/жишээ PDF-д хэрэглэх DejaVu Sans (кирилл, Ө ө Ү ү дэмжинэ) — bytes-ийг нэг удаа уншиж процессын хэмжээнд cache-лэнэ.
import { readFile } from 'node:fs/promises';

export type FontFace = 'regular' | 'bold';

const FONT_MODULE_PATHS: Readonly<Record<FontFace, string>> = {
  regular: 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf',
  bold: 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf',
};

// Promise-ийг cache-лэх тул зэрэгцсэн stamp()-ууд файлыг нэг л удаа уншина; уншилт амжилтгүй бол cache-д үлдээхгүй (дараагийн дуудлага дахин оролдоно)
const cache = new Map<FontFace, Promise<Uint8Array>>();

export function loadFontBytes(face: FontFace): Promise<Uint8Array> {
  const cached = cache.get(face);
  if (cached) return cached;
  const pending = readFile(require.resolve(FONT_MODULE_PATHS[face]));
  cache.set(face, pending);
  pending.catch(() => {
    if (cache.get(face) === pending) cache.delete(face);
  });
  return pending;
}
