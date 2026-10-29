// Худалдан авагчийн утас/регистрийн оролтыг (paste, автоматаар бөглөх) баталгаажуулахаас ӨМНӨ жигдэлнэ. PII — лог/URL/storage-д бичихгүй (POS-BR-7).
// Анхаар: input-д богино `maxLength` тавихгүй. Хөтөч paste-ийг `maxLength`-ээр жигдлэхээс өмнө тайрдаг тул '+976 9911-2233' зэрэг форматтай дугаар тасарч буруу болдог.

/**
 * '+976 9911-2233', '(976) 99112233', '0097699112233', '9911 2233' → '99112233'.
 * Улсын код 976-г зөвхөн бүтэн дугаар (976 + 8 орон = 11 орон, 00976 + 8 = 13 орон) үед хасна — 8 оронтой дугаарын эхний цифрийг хэзээ ч иддэггүй.
 * 8-аас урт үлдсэн бол тайрахгүй (буруу дугаар баталгаажуулалтад алдаа үзүүлнэ).
 */
export function normalizePhone(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('00976')) return digits.slice(5);
  if (digits.length === 11 && digits.startsWith('976')) return digits.slice(3);
  return digits;
}

/** 'уб 12345678', 'УБ-1234 5678', ' ув12345678 ' → 'УБ12345678': том үсэг, зай/зураас/цэг/тусгаарлагч хасна. Урт нь тайрагдахгүй. */
export function normalizeRegister(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[\s\u200B-\u200D\uFEFF\-–—._/]/g, '');
}

/** Утасны input-ийн DOM `maxLength`: дугаарын форматтай (+976, зай, зураас) paste-д хангалттай; жинхэнэ шалгалт normalize + schema-д. */
export const PHONE_INPUT_MAXLENGTH = 20;
/** Регистрийн input-ийн DOM `maxLength` (УБ 1234 5678 зэрэг форматтай paste-д хангалттай). */
export const REGISTER_INPUT_MAXLENGTH = 16;
