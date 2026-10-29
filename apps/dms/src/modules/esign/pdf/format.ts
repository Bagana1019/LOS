// FR-11.4 Штамп дээрх огноо, баталгаажуулах кодын хэлбэржүүлэлт — цэвэр функцүүд (цагийн бүс, локаль-ээс үл хамаарна).

/** Монгол Улс 2017 оноос зуны цаггүй — Asia/Ulaanbaatar = UTC+8 тогтмол. Intl/ICU-д найдахгүй тул үр дүн орчноос хамаарахгүй. */
const ULAANBAATAR_OFFSET_MS = 8 * 60 * 60 * 1000;
const PT_PER_MM = 72 / 25.4;

export const mm = (millimetres: number): number => millimetres * PT_PER_MM;

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `YYYY-MM-DD HH:mm:ss` Улаанбаатарын цагаар (UTC+8). */
export function formatUlaanbaatar(date: Date): string {
  const shifted = new Date(date.getTime() + ULAANBAATAR_OFFSET_MS);
  // toISOString() нь 9999 оноос хойших огноог `+010000-…` болгодог (хугацаагүй гэрчилгээний notAfter=9999-12-31 + 8ц) тул гараар угсарна
  const day = `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  return `${day} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

/** Баталгаажуулах код `XXXX-XXXX-XXXX` хэлбэрээр (хадгалах хэлбэр нь зураасгүй). Танигдахгүй тэмдэгттэй бол өөрчлөхгүй. */
export function groupVerificationCode(code: string): string {
  const compact = code.replace(/-/g, '').toUpperCase();
  if (!/^[0-9A-Z]+$/.test(compact)) return code;
  return compact.match(/.{1,4}/g)?.join('-') ?? code;
}
