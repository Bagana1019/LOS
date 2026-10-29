// Нүдний текстийг цэвэрлэх нийтлэг helper (PDF, OCR, CSV, TEXT). Утга хасахгүй: зөвхөн хоосон зай, удирдлагын/тэг өргөнтэй (zero-width) тэмдэгт.
// eslint-disable-next-line no-control-regex
const NON_PRINTING_RE = /[\u0000-\u0008\u000e-\u001f\u007f\u200b-\u200d\u2060]/g;

/** Бүх төрлийн хоосон зайг (NBSP, TAB, шинэ мөр...) нэг зай болгож, удирдлагын/zero-width тэмдэгтийг хасаж, trim хийнэ. */
export function cleanCellText(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(NON_PRINTING_RE, '').trim();
}

/** text = хоосон биш нүднүүдийг нэг зайгаар залгасан (StatementTextLine.text-ийн гэрээ) */
export function joinCells(cells: readonly string[]): string {
  return cells.filter((c) => c !== '').join(' ');
}
