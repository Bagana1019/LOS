// Multipart хүсэлтийг UploadService-ийн оролт болгох + бүх файл татгалзагдсан үед HTTP статус сонгох.
import { HttpStatus } from '@nestjs/common';
import type { BankCode, BsaUploadBanks } from '@los/contracts';
import type { UploadFileInput, UploadResult } from '../upload.service';
import type { UploadRejectCode } from '../import.issues';
import { BsaException } from '../import.errors';
import { BsaValidationException } from './zod-validation.pipe';

/** Express.Multer.File-ийн бидэнд хэрэгтэй хэсэг (глобал `Express.Multer` төрлөөс хамааралгүй) */
export interface UploadedPart {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/** `banks` (массив эсвэл индексээр объект) → файл бүрийн банк. Файлын тооноос хэтэрсэн индекс ⇒ 400 */
export function banksByIndex(banks: BsaUploadBanks | undefined, fileCount: number): Array<BankCode | null> {
  const result: Array<BankCode | null> = Array.from({ length: fileCount }, () => null);
  if (banks === undefined) return result;
  const entries: Array<[number, BankCode | null]> = Array.isArray(banks)
    ? banks.map((b, i): [number, BankCode | null] => [i, b])
    : Object.entries(banks).map(([k, b]): [number, BankCode | null] => [Number(k), b]);
  for (const [index, bank] of entries) {
    // Массив дахь null «автомат» гэсэн утгатай тул файлгүй индекс дээр ч зөвшөөрнө; банк заасан бол файл заавал байх ёстой
    if (index >= fileCount) {
      if (bank === null) continue;
      throw new BsaValidationException([{ path: `banks.${index}`, code: 'custom' }]);
    }
    result[index] = bank;
  }
  return result;
}

export function toUploadInputs(files: readonly UploadedPart[], banks: BsaUploadBanks | undefined): UploadFileInput[] {
  const bankOf = banksByIndex(banks, files.length);
  return files.map((f, i) => ({ content: f.buffer, fileName: f.originalname, mimeType: f.mimetype, bankCode: bankOf[i] }));
}

/** Бүх файл татгалзагдсан үеийн HTTP статус (файл бүрийн шалтгаанаас эхний нь) */
const REJECT_STATUS: Readonly<Record<UploadRejectCode, HttpStatus>> = {
  FILE_UNSUPPORTED: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  XLSX_UNSUPPORTED: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  FILE_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  FILE_EMPTY: HttpStatus.BAD_REQUEST,
  INVALID_BANK: HttpStatus.BAD_REQUEST,
  QUEUE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  STORAGE_FAILED: HttpStatus.SERVICE_UNAVAILABLE,
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * Хэрэглэгч нэг ч файл хүлээн аваагүй, мөн давхардал ч биш (бүгд REJECTED) үед хүсэлт өөрөө алдаа: 415 / 413 / 400 / 503. Файл бүрийн
 * `outcomes` нь алдааны `details`-д орно. Зарим нь хүлээн авагдсан, эсвэл давхардсан бол хүсэлт амжилттай (202 / 200) — файл бүрийг outcomes-оос харна.
 */
export function assertSomethingHandled(result: UploadResult): void {
  if (result.accepted > 0 || result.duplicates > 0 || result.rejected === 0) return;
  const first = result.outcomes.find((o) => o.status === 'REJECTED');
  const code = (first && first.status === 'REJECTED' ? first.code : 'INTERNAL_ERROR') as UploadRejectCode;
  throw new BsaException(REJECT_STATUS[code] ?? HttpStatus.UNPROCESSABLE_ENTITY, code, {
    outcomes: result.outcomes,
    accepted: result.accepted,
    duplicates: result.duplicates,
    rejected: result.rejected,
  });
}
