import { describe, expect, it } from 'vitest';
import { ocrResultFromText } from '../providers/result';
import { buildDoc } from './doc';
import { ID_CARD_LABELS } from './id-card';
import { findAllLabelHits, findLabelHits, levenshtein, maxLabelDistance, valueCandidates, type LabelDef } from './labels';

const docOf = (text: string) => buildDoc(ocrResultFromText(text));
const hitsOf = (text: string, defs: readonly LabelDef[] = ID_CARD_LABELS) => {
  const doc = docOf(text);
  return { doc, hits: findAllLabelHits(doc, defs) };
};
const slice = (doc: ReturnType<typeof docOf>, c: { start: number; end: number }) => doc.text.slice(c.start, c.end);

describe('levenshtein, maxLabelDistance', () => {
  it('засварын зай', () => {
    expect(levenshtein('ovog', 'ovot')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('богино шошго яг таарна, урт шошго нэг алдаа зөвшөөрнө, маш урт хоёр', () => {
    expect([2, 3, 4, 6, 11, 12, 17, 18].map(maxLabelDistance)).toEqual([0, 0, 1, 1, 1, 2, 2, 3]);
  });
});

describe('findLabelHits', () => {
  it('шошго бүрийн талбар, байрлал, засварын зайг буцаана', () => {
    const { doc, hits } = hitsOf('Овот: Дорж');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ field: 'lastName', distance: 1, tokenCount: 1 });
    expect(slice(doc, hits[0])).toBe('Овот');
  });

  it('олон үгтэй шошго нь 1 үгтэй шошгоос давуу: "Эцэг/эхийн нэр" → patronymic (firstName биш)', () => {
    const { hits } = hitsOf('Эцэг/эхийн нэр: Бат');
    expect(hits.map((h) => h.field)).toEqual(['patronymic']);
  });

  it('үг нийлсэн/салсан ("РегистрийнДугаар", "Регистрийн  дугаар") ч таарна', () => {
    expect(hitsOf('Регистрийн дугаар: ЖЮ85061512').hits[0].field).toBe('registerNo');
    expect(hitsOf('Регистрийндугаар: ЖЮ85061512').hits[0].field).toBe('registerNo');
  });

  it('утга дотор шошгыг санагдуулах ойролцоо үг байвал хуурамч цохилт өгөхгүй ("Нэрмээ", "Овогт" гэх мэт 3-аас урт үг)', () => {
    expect(hitsOf('Нэрмээ Батаа').hits).toEqual([]);
    expect(hitsOf('Хүйсийн тухай').hits).toEqual([]);
  });

  it('3 ба түүнээс богино шошго (Нэр, Sex, РД) яг таарна: нэг үсгийн алдаа хүлээн авахгүй', () => {
    expect(hitsOf('Нэр: Болд').hits[0]?.field).toBe('firstName');
    expect(hitsOf('Нэп: Болд').hits).toEqual([]);
    expect(hitsOf('Sex: M').hits[0]?.field).toBe('gender');
    expect(hitsOf('Sax: M').hits).toEqual([]);
  });

  it('нэг мөрөнд хоёр шошго, байрлалаар эрэмбэлэгдэнэ', () => {
    const { hits } = hitsOf('Овог: Дорж     Нэр: Болд');
    expect(hits.map((h) => h.field)).toEqual(['lastName', 'firstName']);
    expect(hits[0].start).toBeLessThan(hits[1].start);
  });

  it('хэт урт токенийг (адверсари) алгасна', () => {
    const doc = docOf(`${'Овог'.repeat(20)} Овог`);
    const hits = findLabelHits(doc.lines[0], ID_CARD_LABELS);
    expect(hits).toHaveLength(1);
    expect(doc.text.slice(hits[0].start, hits[0].end)).toBe('Овог');
  });
});

describe('valueCandidates', () => {
  it('нэг мөрийн утга: шошгоны дараахаас дараагийн шошго хүртэл', () => {
    const { doc, hits } = hitsOf('Овог: Дорж     Нэр: Болд');
    const [a] = valueCandidates(doc, hits, 'lastName');
    expect(slice(doc, a).trim()).toBe(': Дорж');
    expect(a.source).toBe('same-line');
    const [b] = valueCandidates(doc, hits, 'firstName');
    expect(slice(doc, b).trim()).toBe(': Болд');
  });

  it('шошгоны дараа юу ч үгүй бол дараагийн мөр нэмэгдэнэ; дараагийн мөр шошгоор эхэлбэл нэмэхгүй', () => {
    const a = hitsOf('Овог\nДорж');
    const cands = valueCandidates(a.doc, a.hits, 'lastName');
    expect(cands.map((c) => c.source)).toEqual(['same-line', 'next-line']);
    expect(slice(a.doc, cands[1])).toBe('Дорж');
    const b = hitsOf('Овог\nНэр: Болд');
    expect(valueCandidates(b.doc, b.hits, 'lastName').map((c) => c.source)).toEqual(['same-line']);
  });

  it('хоёр шошготой мөрийн дараагийн мөрийг баганаар хуваана', () => {
    const { doc, hits } = hitsOf('Овог                 Нэр                 Хүйс\nДорж                 Болд                Эр');
    const next = (f: string) => slice(doc, valueCandidates(doc, hits, f).find((c) => c.source === 'next-line') ?? { start: 0, end: 0 });
    expect(next('lastName')).toBe('Дорж');
    expect(next('firstName')).toBe('Болд');
    expect(next('gender')).toBe('Эр');
  });

  it('баганад үг байхгүй бол тэр баганын нэр дэвшигч нэмэгдэхгүй (өөр баганын утгыг авахгүй)', () => {
    const { doc, hits } = hitsOf('Овог                 Нэр                 Хүйс\nДорж                                     Эр');
    const next = valueCandidates(doc, hits, 'firstName').filter((c) => c.source === 'next-line');
    expect(next).toEqual([]);
  });

  it('хайрцаггүй (page.text fallback) мөрүүдэд баганын хуваалт хийхгүй, бүтэн мөрийг авна', () => {
    const base = ocrResultFromText('x');
    const doc = buildDoc({ ...base, pages: [{ ...base.pages[0], lines: [], text: 'Овог Нэр\nДорж Болд', meanConfidence: 0.9 }] });
    const hits = findAllLabelHits(doc, ID_CARD_LABELS);
    const next = valueCandidates(doc, hits, 'lastName').find((c) => c.source === 'next-line');
    expect(next && slice(doc, next)).toBe('Дорж Болд');
  });
});
