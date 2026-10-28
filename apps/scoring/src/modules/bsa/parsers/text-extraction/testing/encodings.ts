// Тестийн кодлогч: Node-д windows-1251 ENCODER байхгүй тул байтуудыг гараар тавина (TextDecoder зөвхөн decode хийдэг).
const CP1251_SPECIAL: Readonly<Record<string, number>> = {
  Ё: 0xa8, ё: 0xb8, '№': 0xb9,
  // Монгол кирилл (таамаг, text-decoding.ts-тэй ижил): Ө/Ү нь украин Є/Ї-ийн байранд
  Ө: 0xaa, ө: 0xba, Ү: 0xaf, ү: 0xbf,
};

export function encodeCp1251(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) bytes.push(cp);
    else if (cp >= 0x0410 && cp <= 0x044f) bytes.push(0xc0 + (cp - 0x0410));
    else if (ch in CP1251_SPECIAL) bytes.push(CP1251_SPECIAL[ch]);
    else throw new Error(`cp1251-д байхгүй тэмдэгт U+${cp.toString(16)}`);
  }
  return Buffer.from(bytes);
}

export function encodeUtf16(text: string, endian: 'le' | 'be', bom = true): Buffer {
  const le = Buffer.from(text, 'utf16le');
  const body = endian === 'le' ? le : Buffer.from(le).swap16();
  const mark = endian === 'le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
  return bom ? Buffer.concat([mark, body]) : body;
}

export const utf8Bom = (text: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
