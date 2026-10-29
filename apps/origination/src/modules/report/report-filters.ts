import type { ReportColumn, ReportFilterDef } from '@los/contracts';
import { CURRENCY, type Option } from './report-labels';

// Шүүлтийн тодорхойлолтууд — түлхүүр нь ReportQuery-н талбар. `productId`-ийн сонголтыг ReportService бүтээгдэхүүний каталогоос нөхнө.
export const F = {
  asOf: { key: 'asOf', label: 'Огноо (байдлаар)', type: 'date' } satisfies ReportFilterDef,
  dateFrom: (label = 'Эхлэх огноо'): ReportFilterDef => ({ key: 'dateFrom', label, type: 'date' }),
  dateTo: (label = 'Дуусах огноо'): ReportFilterDef => ({ key: 'dateTo', label, type: 'date' }),
  branch: { key: 'branchId', label: 'Салбар', type: 'text' } satisfies ReportFilterDef,
  officer: { key: 'officerId', label: 'ЗЭЗ', type: 'text' } satisfies ReportFilterDef,
  product: { key: 'productId', label: 'Бүтээгдэхүүн', type: 'text' } satisfies ReportFilterDef,
  currency: { key: 'currency', label: 'Валют', type: 'select', options: CURRENCY } satisfies ReportFilterDef,
  search: { key: 'search', label: 'Хайх (регистр, гэрээний дугаар, нэр)', type: 'text' } satisfies ReportFilterDef,
  select: (key: 'status' | 'provider' | 'assetType', label: string, options: Option[]): ReportFilterDef => ({ key, label, type: 'select', options }),
};

export interface ColOpts { width?: number; sortable?: boolean; options?: Option[] }
/** Баганы тодорхойлолт. `sortable` анхдагчаар true (SQL-ийн баганаар эрэмбэлнэ); регистр гэх мэт JS-д тооцсон баганад false. */
export const col = (key: string, label: string, type: ReportColumn['type'], o: ColOpts = {}): ReportColumn => ({
  key, label, type, ...(o.width ? { width: o.width } : {}), sortable: o.sortable ?? true, ...(o.options ? { options: o.options } : {}),
});
