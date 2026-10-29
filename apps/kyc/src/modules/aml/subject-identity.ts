import type { AmlSubject } from '@los/contracts';

/** Субъектийн "хэн болох"-ыг тодорхойлогч талбарууд (регистр ороогүй: тэр нь registerNoHash-аар тусад нь тулгагдана). */
export type IdentitySubject = Pick<AmlSubject, 'subjectType' | 'firstName' | 'aliases' | 'countries'> & Partial<Pick<AmlSubject, 'lastName' | 'birthDate'>>;

/** Текст бүр: NFKC → жижиг үсэг → зайг нэг болгож тайрах. Харьцуулалтад л хэрэглэнэ (хадгалахгүй, лог-д бичихгүй). */
const text = (value: string | undefined): string => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
// Хадгалсан snapshot нь DB-ийн JSON тул массив байхгүй (хуучин / гэмтсэн мөр) байж болзошгүй: хоосон гэж үзнэ.
const uniqueSorted = (values: readonly string[] | undefined): string[] => [...new Set((values ?? []).map(text).filter((v) => v !== ''))].sort();

/**
 * AML-ийн identity guard / carry-over-д хэрэглэх субъектийн каноник түлхүүр (BR-9, FR-3.4): төрөл, овог, нэр, бусад нэр (эрэмбэлсэн,
 * давхардалгүй), төрсөн огноо, улсууд (эрэмбэлсэн). registerNo ороогүй (registerNoHash-аар тулгана); isPep / isRelatedParty ороогүй
 * (эдгээр нь хэн гэдгийг биш эрсдэлийн шинж тэмдгийг илэрхийлнэ). Хадгалсан snapshot (StoredScreening.subject) эсвэл шинэ хүсэлтийн
 * subject-ээс ижил дүрмээр бодогдоно — улсын анхдагч утгыг дуудагч өгнө.
 */
export function subjectIdentityKey(subject: IdentitySubject): string {
  return JSON.stringify({
    subjectType: subject.subjectType,
    lastName: text(subject.lastName),
    firstName: text(subject.firstName),
    aliases: uniqueSorted(subject.aliases),
    birthDate: subject.birthDate ?? '',
    countries: uniqueSorted(subject.countries),
  });
}
