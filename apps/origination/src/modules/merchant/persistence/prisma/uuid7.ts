import { randomBytes } from 'node:crypto';

// UUIDv7 (RFC 9562): 48 bit unix ms + 12 bit монотон тоолуур + санамсаргүй. Postgres uuid нь байтаар эрэмбэлэгддэг тул нэг процесс дотор
// үүсгэсэн id-нууд оруулсан дарааллаараа эрэмбэлэгдэнэ (pos_lease_event: ORDER BY at, id — ижил `at`-тай бичлэгийн тогтвортой дараалал).
let lastMs = 0;
let lastSeq = 0;

export function uuidV7(nowMs: number = Date.now()): string {
  let ms = nowMs;
  let seq: number;
  if (ms > lastMs) {
    seq = 0;
  } else {
    // цаг ухарсан эсвэл ижил ms: монотон байдлыг хадгална
    ms = lastMs;
    seq = lastSeq + 1;
    if (seq > 0xfff) {
      ms += 1;
      seq = 0;
    }
  }
  lastMs = ms;
  lastSeq = seq;
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
