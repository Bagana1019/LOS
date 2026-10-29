// GENERIC: баримтаас бүх регистр, IBAN, огноо, дүн, утас олж массиваар буцаана. Олдсон хэсгийг далдалж давхардуулахгүй:
// дараалал IBAN → регистр → огноо → утас → дүн (8 оронтой, 6-9-өөр эхэлсэн бүхэл тоог утас гэж үзнэ).
import type { ExtractSettings } from './defaults';
import type { OcrDoc } from './doc';
import { combineConfidence, makeField } from './field';
import type { FieldsResult } from './id-card';
import { findAmounts, findIbans, findIsoDates, findPhones, findRegisterCandidates, findTimes, maskSpans, type Span } from './scan';
import type { ExtractedField } from './types';

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

interface Item<T> extends Span {
  value: T;
  validated: boolean;
}

function toField<T extends string | number>(items: Array<Item<T>>, doc: OcrDoc, settings: ExtractSettings, heuristic: boolean): ExtractedField {
  const values = unique(items.map((i) => i.value)) as string[] | number[];
  const first = new Map<T, Item<T>[]>();
  for (const i of items) first.set(i.value, [...(first.get(i.value) ?? []), i]);
  const confs = [...first.values()].map((group) => {
    const best = Math.max(...group.map((g) => combineConfidence(doc.spanConf(g.start, g.end), { validated: g.validated, heuristic })));
    return best;
  });
  return makeField({ value: values, raw: items.length > 0 ? items.map((i) => i.raw).join(' | ') : null, confidence: items.length > 0 ? Math.round(mean(confs) * 1000) / 1000 : 0 }, settings);
}

export function extractGeneric(doc: OcrDoc, settings: ExtractSettings): FieldsResult {
  const ibans = findIbans(doc.text);
  let masked = maskSpans(doc.numText, ibans);
  // регистрийг эх текстээс (numText дээр 'B'→'8' болж гажина) хайж, offset-ээр numText-д далдална
  const regs = findRegisterCandidates(maskSpans(doc.text, ibans)).filter((c) => c.info.valid);
  masked = maskSpans(masked, regs);
  const dates = findIsoDates(masked);
  masked = maskSpans(masked, dates);
  masked = maskSpans(masked, findTimes(masked));
  const phones = findPhones(masked);
  masked = maskSpans(masked, phones);
  // GENERIC-д мөнгөн дүн = мянгатын тусгаарлагч/аравтын хэсэгтэй эсвэл мөнгөн тэмдэгтэй, тэгээс их (энгийн жижиг бүхэл тоо = дугаар/хуудас г.м. шуугиан)
  const amounts = findAmounts(masked).filter((a) => a.value > 0 && (a.formatted || a.currency));

  const fields: Record<string, ExtractedField> = {
    registerNos: toField(
      regs.map((r) => ({ start: r.start, end: r.end, raw: r.raw, value: r.info.value as string, validated: true })),
      doc,
      settings,
      false,
    ),
    ibans: toField(ibans.map((i) => ({ ...i, value: i.iban, validated: true })), doc, settings, false),
    dates: toField(dates.map((d) => ({ ...d, value: d.iso, validated: true })), doc, settings, false),
    amounts: toField(amounts.map((a) => ({ ...a, value: a.value, validated: a.currency })), doc, settings, true),
    phones: toField(phones.map((p) => ({ ...p, value: p.phone, validated: false })), doc, settings, true),
  };
  return { fields, warnings: [] };
}
