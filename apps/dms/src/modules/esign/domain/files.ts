// FR-11.4 DMS файлтай холбоотой цэвэр туслахууд: PDF таних, гарын үсэгтэй файлуудын нэр.
const PDF_MAGIC = '%PDF-';
/** PDF header-ийг эхний 1024 байтаас хайна (Acrobat-ийн хүлцэл; pdf/pdf-lib-stamper.ts-тэй ижил) */
const HEADER_SCAN_BYTES = 1024;
const MAX_NAME_LENGTH = 255;
// eslint-disable-next-line no-control-regex -- файлын нэрээс хяналтын тэмдэгтийг зориуд арилгана
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f\\/:*?"<>|]+/g;

export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, HEADER_SCAN_BYTES).includes(PDF_MAGIC);
}

/** Гэрээний дугаарыг файлын нэрэнд аюулгүй болгоно (зам салгагч, хяналтын тэмдэгт, хэт урт). Хоосон бол `contract` */
export function safeFileStem(contractNo: string): string {
  const cleaned = contractNo.replace(UNSAFE_NAME_CHARS, '_').replace(/\s+/g, ' ').trim();
  const stem = Array.from(cleaned).slice(0, MAX_NAME_LENGTH - '-signed.pdf'.length).join('');
  return stem === '' ? 'contract' : stem;
}

/** Зээлдэгчид/provider-т үзүүлэх эх гэрээний нэр */
export function sourceDocumentName(contractNo: string): string {
  return `${safeFileStem(contractNo)}.pdf`;
}

export function signedPdfName(contractNo: string): string {
  return `${safeFileStem(contractNo)}-signed.pdf`;
}

export function signatureFileName(contractNo: string): string {
  return `${safeFileStem(contractNo)}.p7s`;
}
