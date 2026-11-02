import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { DocumentOcrVerdict } from '@los/contracts';
import { ApiError } from '../../lib/http';
import { IDS, makeBorrower } from '../collateral/collateral.fixtures';
import { countOf, tagsWithTestId, visibleText } from '../collateral/html.fixtures';
import { DocumentChecklistRow, ExtraDocumentsCard } from './DocumentRow';
import { makeDocument, makeOcr, makeRow } from './documents.fixtures';
import { borrowerOptions } from './documents.utils';
import { OcrResult } from './OcrResult';
import { ApiErrorAlert } from './shared/ApiErrorAlert';

const wrap = (node: React.ReactNode) => renderToString(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('OcrResult', () => {
  it.each(DocumentOcrVerdict.map((v) => [v]))('%s: дүгнэлтийн шошго ба зөвлөмж', (verdict) => {
    const html = renderToString(<OcrResult check={makeOcr({ verdict })} />);
    expect(tagsWithTestId(html, 'ocr-result')[0]).toContain('role="status"');
    const text = visibleText(html);
    expect(text).toContain('OCR тулгалт');
    expect(text).not.toContain('document.ocr.');
    expect(text).toContain('OCR нь зөвлөмж бөгөөд эцсийн баталгаажуулалтыг ажилтан хийнэ.');
  });
  it('MATCH: далдлагдсан регистр, итгэлцэл', () => {
    const text = visibleText(renderToString(<OcrResult check={makeOcr({ confidence: 0.93 })} />));
    expect(text).toContain('Регистр таарсан');
    expect(text).toContain('Регистр: УБ****5678');
    expect(text).toContain('Итгэлцэл: 93%');
    expect(text).not.toMatch(/УБ\d{8}/); // бүтэн регистр харуулахгүй
  });
  it('MISMATCH: алдааны төрөл; анхааруулга монгол/англи', () => {
    const html = renderToString(<OcrResult check={makeOcr({ verdict: 'MISMATCH', confidence: null, registerMasked: null, warnings: ['Регистр зөрсөн', 'low quality scan'] })} />);
    expect(html).toContain('ant-alert-error');
    const text = visibleText(html);
    expect(text).toContain('Регистр таарахгүй');
    expect(text).toContain('Регистр зөрсөн');
    expect(text).toContain('OCR анхааруулга гарсан — баримтыг гараар шалгана уу.');
    expect(text).not.toContain('low quality scan');
    expect(text).not.toContain('Итгэлцэл');
  });
});

describe('ApiErrorAlert', () => {
  it('алдаагүй бол юу ч гаргахгүй', () => {
    expect(renderToString(<ApiErrorAlert error={null} scope="document" />)).toBe('');
  });
  it('role=alert, монгол мессеж', () => {
    const html = renderToString(<ApiErrorAlert error={new ApiError(409, 'APPLICATION_NOT_EDITABLE', 'Conflict')} scope="document" />);
    expect(html).toContain('role="alert"');
    expect(visibleText(html)).toBe('Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт байх үед л өөрчилнө.');
  });
  it('гарчиг, талбарын жагсаалт, дахин оролдох товч', () => {
    const error = new ApiError(422, 'VALIDATION_FAILED', 'x', [{ path: 'fileId', message: 'Invalid uuid' }]);
    const html = renderToString(<ApiErrorAlert error={error} scope="collateral" title="Барьцааны мэдээллийг ачаалж чадсангүй" onRetry={() => undefined} />);
    const text = visibleText(html);
    expect(text).toContain('Барьцааны мэдээллийг ачаалж чадсангүй');
    expect(text).toContain('Оруулсан мэдээлэл буруу байна');
    expect(text).toContain('fileId талбар буруу байна');
    expect(text).toContain('Дахин ачаалах');
  });
});

describe('Баримтын checklist мөр', () => {
  const props = { applicationId: IDS.app, borrowers: borrowerOptions([makeBorrower()]), canEdit: true, onRemove: () => undefined, onAttach: () => undefined, removingId: null };

  it('заавал, дутуу мөр: шошго, «файл хавсаргаагүй»', () => {
    const html = wrap(<DocumentChecklistRow row={makeRow({ key: 'income_proof', name: 'Орлогын тодорхойлолт' })} {...props} />);
    const text = visibleText(html);
    expect(text).toContain('Орлогын тодорхойлолт');
    expect(text).toContain('Заавал');
    expect(text).toContain('Дутуу');
    expect(text).toContain('Файл хавсаргаагүй');
    expect(html).toContain('data-key="income_proof"');
    expect(html).toContain('aria-label="Файл хавсаргах: Орлогын тодорхойлолт"');
  });

  it('хангагдсан мөр: файл, хэмжээ, татах/хасах товчны нэр', () => {
    const doc = makeDocument({ fileName: 'income.pdf', size: 1536 });
    const html = wrap(<DocumentChecklistRow row={makeRow({ key: 'income_proof', name: 'Орлогын тодорхойлолт', documents: [doc] })} {...props} />);
    const text = visibleText(html);
    expect(text).toContain('Хангагдсан');
    expect(text).toContain('income.pdf');
    expect(text).toContain('1.5 КБ');
    expect(html).toContain('aria-label="Татах: income.pdf"');
    expect(html).toContain('aria-label="Хасах: income.pdf"');
    expect(countOf(html, 'data-testid="document-item"')).toBe(1);
    expect(html).not.toContain('OCR шалгах'); // зөвхөн id_card мөрөнд
  });

  it('id_card мөрөнд OCR товч', () => {
    const html = wrap(<DocumentChecklistRow row={makeRow({ key: 'id_card', name: 'Иргэний үнэмлэх', documents: [makeDocument()] })} {...props} />);
    expect(html).toContain('aria-label="OCR шалгах: id-front.pdf"');
  });

  it('зээлдэгчид холбосон баримт: нэрээр', () => {
    const doc = makeDocument({ relatedEntity: 'BORROWER', relatedId: IDS.owner });
    expect(visibleText(wrap(<DocumentChecklistRow row={makeRow({ key: 'id_card', name: 'Иргэний үнэмлэх', documents: [doc] })} {...props} />))).toContain('Зээлдэгч: Бат Болд');
  });

  it('засах эрхгүй: хавсаргах, хасах, OCR идэвхгүй', () => {
    const html = wrap(<DocumentChecklistRow row={makeRow({ key: 'id_card', name: 'Иргэний үнэмлэх', documents: [makeDocument()] })} {...props} canEdit={false} />);
    for (const label of ['Файл хавсаргах: Иргэний үнэмлэх', 'Хасах: id-front.pdf', 'OCR шалгах: id-front.pdf']) {
      const tag = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(tag, label).toContain('disabled=""');
    }
  });

  it('заавал биш мөр', () => {
    const text = visibleText(wrap(<DocumentChecklistRow row={makeRow({ key: 'extra', name: 'Нэмэлт', required: false })} {...props} />));
    expect(text).toContain('Заавал биш');
  });
});

describe('Нэмэлт баримтын карт', () => {
  const props = { applicationId: IDS.app, borrowers: [], canEdit: true, onRemove: () => undefined, onAttach: () => undefined, removingId: null };
  it('хоосон ба файлтай', () => {
    expect(visibleText(wrap(<ExtraDocumentsCard docs={[]} {...props} />))).toContain('Нэмэлт баримт алга');
    const html = wrap(<ExtraDocumentsCard docs={[makeDocument({ type: 'other', checklistKey: null, fileName: 'zurag.png', note: 'Хашааны зураг' })]} {...props} />);
    const text = visibleText(html);
    expect(text).toContain('zurag.png');
    expect(text).toContain('Хашааны зураг');
    expect(html).toContain('data-testid="extra-documents"');
  });
});
