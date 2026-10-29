// ID_CARD (Иргэний үнэмлэх) талбар задлалт. Шошго: Овог, Нэр, Регистрийн дугаар, Төрсөн огноо, Хүйс, Үнэмлэхний дугаар, Хүчинтэй хугацаа
// (кирилл/латин, OCR-ийн шуугианд тэсвэртэй). Регистрийн дугаараас төрсөн огноо/хүйсийг тооцож зөрүүг анхааруулна.
// TODO(samples): бодит үнэмлэхний зураг байхгүй — шошго/байрлалын хэв маяг зохиомол, баталгаажаагүй.
import type { OcrDoc } from './doc';
import type { ExtractSettings } from './defaults';
import { combineConfidence, emptyField, makeField } from './field';
import { findAllLabelHits, type LabelDef } from './labels';
import { cleanName, parseCardNumber, parseGender, readLabelled, trimSeparators } from './read';
import { resolveRegisterNo } from './register-field';
import { findIsoDates } from './scan';
import type { ExtractedField } from './types';

export const ID_CARD_LABELS: readonly LabelDef[] = [
  { field: 'lastName', labels: ['Овог', 'Surname', 'Last name', 'Family name'] },
  { field: 'patronymic', labels: ['Эцэг эхийн нэр', 'Эцгийн нэр', 'Patronymic'] },
  { field: 'firstName', labels: ['Нэр', 'Given name', 'Given names', 'First name'] },
  {
    field: 'registerNo',
    labels: ['Регистрийн дугаар', 'Регистрийн №', 'Регистр', 'РД', 'Register number', 'Register no', 'Registration number', 'Reg no'],
  },
  { field: 'birthDate', labels: ['Төрсөн огноо', 'Төрсөн өдөр', 'Төрсөн он сар өдөр', 'Date of birth', 'Birth date', 'DOB'] },
  { field: 'gender', labels: ['Хүйс', 'Sex', 'Gender'] },
  { field: 'cardNumber', labels: ['Үнэмлэхний дугаар', 'Үнэмлэхний №', 'Үнэмлэх №', 'Card number', 'Card no', 'ID number', 'Document number'] },
  { field: 'issueDate', labels: ['Олгосон огноо', 'Олгосон өдөр', 'Date of issue', 'Issue date'] },
  { field: 'expiryDate', labels: ['Хүчинтэй хугацаа', 'Хүчинтэй огноо', 'Хүчинтэй', 'Valid until', 'Date of expiry', 'Expiry date'] },
];

export interface FieldsResult {
  fields: Record<string, ExtractedField>;
  warnings: string[];
}

export function extractIdCard(doc: OcrDoc, settings: ExtractSettings): FieldsResult {
  const hits = findAllLabelHits(doc, ID_CARD_LABELS);
  const warnings: string[] = [];
  const make = (a: Parameters<typeof makeField>[0]): ExtractedField => makeField(a, settings);
  const fields: Record<string, ExtractedField> = {};

  // ---- нэрс ----
  for (const key of ['lastName', 'firstName', 'patronymic'] as const) {
    const r = readLabelled(doc, hits, key, (seg) => cleanName(seg.text));
    if (!r) {
      fields[key] = emptyField('Олдсонгүй');
      continue;
    }
    const conf = combineConfidence(doc.spanConf(r.seg.start, r.seg.end), { labelDistance: r.cand.hit.distance });
    fields[key] = make({ value: r.value.value, raw: trimSeparators(r.seg.text), confidence: r.value.noisy ? conf * 0.85 : conf, notes: [r.value.noisy ? 'Нэрэнд тоо/илүү үг орсон' : undefined] });
  }

  // ---- регистр ----
  const regResult = resolveRegisterNo(doc, hits, settings);
  fields.registerNo = regResult.field;
  warnings.push(...regResult.warnings);
  const registerInfo = regResult.info;

  // ---- огноонууд ----
  const dateField = (key: 'birthDate' | 'issueDate' | 'expiryDate', pick: (isos: string[]) => string): { iso: string | null; field: ExtractedField } => {
    const r = readLabelled(doc, hits, key, (seg) => {
      const found = findIsoDates(seg.num);
      return found.length > 0 ? found : null;
    });
    if (!r) return { iso: null, field: emptyField('Олдсонгүй') };
    const iso = pick(r.value.map((d) => d.iso));
    const used = r.value.find((d) => d.iso === iso) ?? r.value[0];
    const conf = combineConfidence(doc.spanConf(r.seg.start + used.start, r.seg.start + used.end), { validated: true, labelDistance: r.cand.hit.distance });
    return { iso, field: make({ value: iso, raw: used.raw, confidence: conf }) };
  };
  const birth = dateField('birthDate', (d) => d[0]);
  const issue = dateField('issueDate', (d) => [...d].sort()[0]);
  const expiry = dateField('expiryDate', (d) => [...d].sort()[d.length - 1]);
  fields.issueDate = issue.field;
  fields.expiryDate = expiry.field;

  // ---- хүйс ----
  const genderRead = readLabelled(doc, hits, 'gender', (seg) => parseGender(seg.text));
  let genderValue: 'M' | 'F' | null = null;
  if (genderRead) {
    genderValue = genderRead.value;
    fields.gender = make({
      value: genderValue,
      raw: trimSeparators(genderRead.seg.text),
      confidence: combineConfidence(doc.spanConf(genderRead.seg.start, genderRead.seg.end), { labelDistance: genderRead.cand.hit.distance }),
    });
  }

  // ---- регистрээс гаргасан (унших биш) утгууд + зөрүүний шалгалт ----
  const regConf = fields.registerNo.confidence;
  if (birth.iso) fields.birthDate = birth.field;
  else if (registerInfo?.birthDate) {
    fields.birthDate = make({ value: registerInfo.birthDate, raw: null, confidence: combineConfidence(regConf, { derived: true }), notes: ['Үнэмлэхнээс уншаагүй - регистрийн дугаараас гаргав'] });
  } else fields.birthDate = emptyField('Олдсонгүй');
  if (genderValue === null) {
    fields.gender = registerInfo?.gender
      ? make({ value: registerInfo.gender, raw: null, confidence: combineConfidence(regConf, { derived: true }), notes: ['Үнэмлэхнээс уншаагүй - регистрийн дугаараас гаргав'] })
      : emptyField('Олдсонгүй');
  }
  if (registerInfo) {
    if (birth.iso && registerInfo.birthDate && birth.iso !== registerInfo.birthDate) warnings.push('birthDate: үнэмлэхний төрсөн огноо регистрийн дугаараас зөрж байна');
    if (genderValue && registerInfo.gender && genderValue !== registerInfo.gender) warnings.push('gender: үнэмлэхний хүйс регистрийн дугаараас зөрж байна');
  }

  // ---- үнэмлэхний дугаар ----
  const card = readLabelled(doc, hits, 'cardNumber', (seg) => parseCardNumber(seg.text));
  fields.cardNumber = card
    ? make({ value: card.value, raw: trimSeparators(card.seg.text), confidence: combineConfidence(doc.spanConf(card.seg.start, card.seg.end), { labelDistance: card.cand.hit.distance, heuristic: true }) })
    : emptyField('Олдсонгүй');

  if (settings.today && expiry.iso && expiry.iso < settings.today) warnings.push('expiryDate: үнэмлэхний хүчинтэй хугацаа дууссан байна');

  // талбарын дараалал тогтвортой
  const ordered: Record<string, ExtractedField> = {};
  for (const k of ['lastName', 'firstName', 'patronymic', 'registerNo', 'birthDate', 'gender', 'cardNumber', 'issueDate', 'expiryDate']) ordered[k] = fields[k];
  return { fields: ordered, warnings };
}
