// TEST HELPER — verifier тестүүдийн суурь: SYNTHETIC Хаан-хэлбэрийн хуулгыг engine-ээр уншсан ParsedStatement (толгой, эхний/эцсийн
// үлдэгдэл, мөрийн тоо, IBAN, регистр бүгд хэвлэгдсэн). Бүх өгөгдөл зохиомол.
import { SYNTHETIC_IBAN, SYNTHETIC_REGISTER_NO } from '@los/ocr';
import { BANK_SPECS, bankStatement, specTransactions } from '../../banks/testing/bank-specs';
import type { ParsedStatement, StatementFileMeta } from '../../statement.types';

export const BASELINE_HOLDER = 'Бат-Эрдэнэ Болд';
export { SYNTHETIC_IBAN, SYNTHETIC_REGISTER_NO };

export const PDF_META: StatementFileMeta = {
  fileName: 'synthetic.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1000,
  sha256: '0'.repeat(64),
  pdf: {
    producer: 'SYNTHETIC Report Engine 1.0',
    creator: 'SYNTHETIC Statement Service',
    title: null,
    author: null,
    creationDate: '2026-03-31T10:00:00Z',
    modDate: '2026-03-31T10:00:00Z',
    pageCount: 1,
    isEncrypted: false,
    hasSignature: false,
  },
};

export function baselineParsed(count = 12, seed = 5): ParsedStatement {
  const spec = BANK_SPECS.KHAN;
  const { text } = bankStatement(spec, specTransactions(spec, seed, count), { header: { showClosing: true, showCount: true, footerSummary: true } });
  return spec.parser.parse(text);
}

/** Мутацийн тестэд: гүн хуулбар */
export const clone = <T>(x: T): T => structuredClone(x);
